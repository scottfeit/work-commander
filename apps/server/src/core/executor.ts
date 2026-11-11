import { notFound, conflict } from './errors.js';
import type { Proposal, Settings } from '@wc/shared';
import type { Repo } from './repo.js';
import type { IntegrationHub } from '../integrations/hub.js';
import type { GrantService, AuthScheme } from '../onepassword/grants.js';
import type { SecretStore } from '../secrets/store.js';
import { McpConnection, extractRefs } from '../integrations/mcp.js';
import { bus } from './bus.js';
import { MAX_EMAIL_ATTACHMENT_BYTES, type AttachmentStore, type OutFile } from './attachments.js';

function checkEmailSize(files: OutFile[]) {
  const total = files.reduce((n, f) => n + f.data.length, 0);
  if (total > MAX_EMAIL_ATTACHMENT_BYTES) throw new Error(`Attachments total ${(total / 1048576).toFixed(1)} MB; Gmail allows about ${MAX_EMAIL_ATTACHMENT_BYTES / 1048576} MB. Share a Drive link instead.`);
}

type InternalRunner = (name: string, args: any, ctx: { streamId: string | null; runId: string }) => Promise<string>;

/** Replace {{ticket.key}}, {{ticket.url}}, {{p_xxx.key}} and {{p_xxx.url}} in every string of a payload. */
export function fillPlaceholders(payload: Record<string, unknown>, deps: Proposal[]): Record<string, unknown> {
  const withKey = deps.find((d) => (d.result as any)?.key);
  const sub = (v: string) =>
    v.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, path: string) => {
      const [head, field] = path.split('.');
      const src = head === 'ticket' ? withKey : deps.find((d) => d.id === head);
      const val = (src?.result as any)?.[field];
      return val != null ? String(val) : m;
    });
  const walk = (x: unknown): unknown =>
    typeof x === 'string' ? sub(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)])) : x;
  return walk(payload) as Record<string, unknown>;
}

const asList = (v: unknown) => (Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[,;\s]+/)).map((x) => x.trim()).filter(Boolean);

/**
 * Runs approved proposals against the target systems. Each approved proposal executes as soon as
 * everything it depends on has executed; when no proposal of a run is left undecided, the agent is
 * told what happened (via onRunSettled) so it can continue.
 */
export class Executor {
  onRunSettled?: (runId: string, streamId: string | null, proposals: Proposal[]) => Promise<void>;
  private draining = new Set<string>();
  private redrain = new Set<string>();
  readonly autoApproved = new Set<string>();

  constructor(
    private repo: Repo,
    private hub: IntegrationHub,
    private grants: GrantService,
    private settings: () => Promise<Settings>,
    private secrets: SecretStore,
    private runInternal: () => InternalRunner,
    private attachments?: AttachmentStore,
  ) {}

  async approve(id: string, payload?: Record<string, unknown>, opts: { auto?: boolean } = {}) {
    const p = await this.repo.getProposal(id);
    if (!p) throw notFound('Proposal');
    if (p.status !== 'pending') throw conflict(`Proposal is ${p.status}`);
    if (opts.auto) this.autoApproved.add(id);
    await this.repo.updateProposal(id, { status: 'approved', payload: payload ?? p.payload });
    await this.repo.audit(opts.auto ? 'policy' : 'pu', 'proposal.approved', { id, kind: p.kind, edited: !!payload && JSON.stringify(payload) !== JSON.stringify(p.originalPayload) });
    await this.drain(p.runId, opts.auto);
    return (await this.repo.getProposal(id))!;
  }

  async reject(id: string, reason?: string) {
    const p = await this.repo.getProposal(id);
    if (!p) throw notFound('Proposal');
    if (p.status !== 'pending') throw conflict(`Proposal is ${p.status}`);
    await this.repo.updateProposal(id, { status: 'rejected', error: reason ?? null });
    await this.repo.audit('pu', 'proposal.rejected', { id, reason });
    await this.drain(p.runId);
  }

  /** Save PU edits without approving. */
  async edit(id: string, payload: Record<string, unknown>) {
    const p = await this.repo.getProposal(id);
    if (!p) throw notFound('Proposal');
    if (p.status !== 'pending') throw conflict(`Proposal is ${p.status}`);
    return this.repo.updateProposal(id, { payload });
  }

  async drain(runId: string, suppressSettle = false) {
    // A drain already in progress may have listed proposals before this approval landed: ask it to go around again.
    if (this.draining.has(runId)) {
      this.redrain.add(runId);
      return;
    }
    this.draining.add(runId);
    try {
      for (;;) {
        this.redrain.delete(runId);
        const all = await this.repo.listProposals({ runId });
        const byId = new Map(all.map((p) => [p.id, p]));
        let progressed = false;
        for (const p of all.filter((x) => x.status === 'approved')) {
          const deps = p.dependsOn.map((d) => byId.get(d)).filter((x): x is Proposal => !!x);
          if (deps.some((d) => ['rejected', 'failed', 'expired'].includes(d.status))) {
            await this.repo.updateProposal(p.id, { status: 'failed', error: 'Not executed: a proposal it depends on was rejected or failed' });
            progressed = true;
            continue;
          }
          if (deps.some((d) => d.status !== 'executed')) continue;
          await this.execute(p, deps);
          progressed = true;
        }
        if (!progressed && !this.redrain.has(runId)) break;
      }
      const after = await this.repo.listProposals({ runId });
      const open = after.some((p) => ['pending', 'approved', 'executing'].includes(p.status));
      if (!open && !suppressSettle && this.onRunSettled) await this.onRunSettled(runId, after[0]?.streamId ?? null, after);
    } finally {
      this.draining.delete(runId);
    }
  }

  private async execute(p: Proposal, deps: Proposal[]) {
    await this.repo.updateProposal(p.id, { status: 'executing' });
    const payload = fillPlaceholders(p.payload, deps);
    const unresolved = JSON.stringify(payload).match(/\{\{[^}]+\}\}/);
    try {
      if (unresolved) throw new Error(`Unresolved placeholder ${unresolved[0]}`);
      const result = await this.run(p, payload);
      await this.repo.updateProposal(p.id, { status: 'executed', result, payload });
      await this.repo.audit('executor', 'proposal.executed', { id: p.id, kind: p.kind, result });
      if (p.streamId) await this.repo.updateStream(p.streamId, { touch: true });
    } catch (e: any) {
      await this.repo.updateProposal(p.id, { status: 'failed', error: e.message });
      await this.repo.audit('executor', 'proposal.failed', { id: p.id, kind: p.kind, error: e.message });
      bus.publish({ type: 'notify', streamId: p.streamId, title: 'Action failed', body: `${p.title}: ${e.message}` });
    }
  }

  private async attachInbound(streamId: string | null, inbound: Parameters<Repo['upsertItem']>[0]) {
    const { item } = await this.repo.upsertItem({ ...inbound, streamId });
    if (streamId && item.streamId !== streamId) await this.repo.attachItem(item.id, streamId);
    return item;
  }

  private async run(p: Proposal, x: Record<string, any>): Promise<Record<string, unknown>> {
    if (!this.attachments && Array.isArray(x.attachments) && x.attachments.length) throw new Error('Attachments are not available');
    const files = this.attachments ? await this.attachments.resolve(x.attachments, p.streamId) : [];
    const attached = files.length ? { attachments: files.map((f) => f.filename) } : {};
    switch (p.kind) {
      case 'email_reply': {
        const email = await this.hub.api('email');
        checkEmailSize(files);
        const r = await email.reply({ threadId: x.thread_id, to: asList(x.to), cc: asList(x.cc), subject: x.subject ?? '', body: x.body, files });
        await this.attachInbound(p.streamId, await email.getThread(r.threadId));
        return { ...r, ...attached };
      }
      case 'email_send': {
        const email = await this.hub.api('email');
        checkEmailSize(files);
        const r = await email.send({ to: asList(x.to), cc: asList(x.cc), subject: x.subject, body: x.body, files });
        await this.attachInbound(p.streamId, await email.getThread(r.threadId));
        return { ...r, ...attached };
      }
      case 'slack_post': {
        const chat = await this.hub.api('chat');
        const r = await chat.postMessage({ channel: x.channel, userEmail: x.recipient_email, text: x.text, threadTs: x.thread_ts, files });
        // Track the thread so replies flow back into this stream.
        await this.attachInbound(p.streamId, await chat.getThread(r.channel, x.thread_ts ?? r.ts));
        return { ...r, ...attached };
      }
      case 'ticket_create': {
        const t = await this.hub.api('tickets');
        const r =
          x.flavor === 'jsm'
            ? await t.createJsmRequest({ serviceDeskId: x.service_desk_id, requestTypeId: x.type_id, summary: x.summary, description: x.description, requesterEmail: x.requester_email, assignToSelf: true })
            : await t.createJiraIssue({ projectKey: x.project_key, issueType: x.type_id, summary: x.summary, description: x.description, requesterEmail: x.requester_email, assignToSelf: true });
        if (files.length) await t.attach({ key: r.key, files });
        await this.attachInbound(p.streamId, await t.getIssue(r.key));
        return { ...r, ...attached };
      }
      case 'ticket_comment': {
        const t = await this.hub.api('tickets');
        const issue = await t.getIssue(x.key);
        const r = await t.comment({ key: x.key, body: x.body, public: x.visibility !== 'internal', flavor: issue.data.ticket?.flavor ?? 'jira', files });
        await this.attachInbound(p.streamId, await t.getIssue(x.key));
        return { ...r, key: x.key, ...attached };
      }
      case 'ticket_transition': {
        const t = await this.hub.api('tickets');
        const r = await t.transition({ key: x.key, to: x.to_status, resolution: x.resolution || undefined });
        await this.attachInbound(p.streamId, await t.getIssue(x.key));
        return { ...r, key: x.key };
      }
      case 'credential_request': {
        const g = await this.grants.create({ streamId: p.streamId, item: x.item, allowedHosts: asList(x.allowed_hosts), authScheme: (x.auth_scheme || 'bearer') as AuthScheme });
        return { grant_id: g.id, item: g.title, allowed_hosts: g.hosts, expires_at: g.expiresAt };
      }
      case 'stream_close': {
        if (p.streamId) await this.repo.updateStream(p.streamId, { status: 'closed' });
        return { closed: true };
      }
      case 'mcp_tool_call':
      case 'read_approval': {
        if (x.server === 'wc') {
          const text = await this.runInternal()(x.tool, x.args, { streamId: p.streamId, runId: p.runId });
          return { text: text.slice(0, 20_000), ...extractRefs(text) };
        }
        const s = await this.settings();
        const sys = x.system as 'google' | 'slack' | 'atlassian';
        const mcp = s[sys]?.mcp;
        if (!mcp) throw new Error(`No MCP server configured for ${sys}`);
        const conn = await McpConnection.open(mcp, (id) => this.secrets.get(id));
        try {
          const r = await conn.call(x.tool, x.args ?? {});
          return { text: r.text.slice(0, 20_000), ...extractRefs(r.text) };
        } finally {
          await conn.close();
        }
      }
    }
  }

  /** On restart, proposals mid-execution are unknown state; flag them for the PU. */
  async recoverInterrupted() {
    for (const p of await this.repo.listProposals({ status: ['executing'] })) {
      await this.repo.updateProposal(p.id, { status: 'failed', error: 'Server restarted while executing; check the target system before retrying' });
    }
  }
}
