import { z } from 'zod';
import type { Settings, ThreadMessage } from '@wc/shared';
import type { Repo } from '../core/repo.js';
import { bus } from '../core/bus.js';
import type { InboundItem } from '../integrations/types.js';
import { stripQuoted } from '../integrations/types.js';
import type { AgentBackend } from './backend.js';
import type { StreamAgentRunner } from './runner.js';
import { TRIAGE_RULES, puBlock, streamsBlock } from './prompts.js';

export const TriageDecision = z.object({
  relevant: z.boolean(),
  reason: z.string(),
  stream: z.object({
    action: z.enum(['existing', 'new', 'none']),
    streamId: z.string().nullable(),
    title: z.string().nullable(),
    summary: z.string().nullable(),
    labels: z.array(z.string()).nullable(),
  }),
  updatedSummary: z.string().nullable(),
  notify: z.object({ title: z.string(), body: z.string() }).nullable(),
  next: z.object({ type: z.enum(['none', 'draft', 'offer']), instruction: z.string(), offerLabel: z.string().nullable() }),
});
export type TriageDecision = z.infer<typeof TriageDecision>;

// Message bodies are wrapped as data: they are written to the PU by other people, never instructions or questions for the triage model.
const fmt = (m: ThreadMessage) =>
  `<message from="${m.author.name ?? ''} <${m.author.email ?? m.author.slackUserId ?? ''}>"${m.isFromPU ? ' pu="true"' : ''} at="${m.at}"${m.to?.length ? ` to="${m.to.join(', ')}"` : ''}${m.cc?.length ? ` cc="${m.cc.join(', ')}"` : ''}>\n${stripQuoted(m.text).slice(0, 2500).replace(/<\/?message\b[^>]*>/gi, '')}\n</message>`;

/**
 * The inbound pipeline: store the item, skip what's already seen or authored by the PU, ask
 * Claude whether it matters and where it belongs, then route it into a stream and either draft
 * a response (PU still approves) or offer to do the work.
 */
export class TriagePipeline {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private repo: Repo,
    private backend: AgentBackend,
    private runner: StreamAgentRunner,
    private settings: () => Promise<Settings>,
  ) {}

  /** InboundSink. Serialized so two messages in the same thread can't create two streams. */
  sink = (item: InboundItem) => {
    const next = this.chain.catch(() => undefined).then(() => this.handle(item));
    this.chain = next;
    return next;
  };

  async handle(inbound: InboundItem) {
    const { item, newMessages, created, changed } = await this.repo.upsertItem(inbound);
    if (!changed) return;
    if (!(await this.repo.recordInbound(inbound.source, inbound.eventId, item.id))) return;
    const fresh = newMessages.length ? newMessages : (item.data.messages ?? item.data.ticket?.comments ?? []).slice(-1);
    const fromOthers = fresh.filter((m) => !m.isFromPU);
    if (item.streamId) await this.repo.updateStream(item.streamId, { touch: true });
    if (fromOthers.length === 0 && !(inbound.kind === 'ticket' && (created || newMessages.length === 0))) {
      await this.repo.markInbound(inbound.source, inbound.eventId, false, { skipped: 'authored by PU' });
      return;
    }

    const s = await this.settings();
    const decision = await this.decide(inbound, item.streamId, fresh, s);
    await this.repo.markInbound(inbound.source, inbound.eventId, decision.relevant, decision);
    if (!decision.relevant && !item.streamId) return;

    let streamId = item.streamId;
    if (!streamId) {
      const open = await this.repo.listStreams(false);
      if (decision.stream.action === 'existing' && decision.stream.streamId && open.some((o) => o.id === decision.stream.streamId)) {
        streamId = decision.stream.streamId;
      } else if (decision.stream.action !== 'none') {
        streamId = (await this.repo.createStream({ title: decision.stream.title || inbound.title.slice(0, 80), summary: decision.stream.summary || decision.reason, labels: decision.stream.labels ?? [] })).id;
      }
      if (streamId) await this.repo.attachItem(item.id, streamId);
    } else {
      const prev = await this.repo.getStream(streamId);
      if (prev?.status === 'closed' && decision.relevant) {
        const days = s.claude.reopenClosedWithinDays ?? 14;
        const closedAt = prev.closedAt ? Date.parse(prev.closedAt) : 0;
        if (Date.now() - closedAt <= days * 86_400_000) {
          await this.repo.updateStream(streamId, { status: 'open' }); // recent: carry on in the same stream
        } else {
          // Closed too long ago: this is new work. Start a fresh stream and move the thread over to it.
          const fresh = await this.repo.createStream({
            title: decision.stream.title || inbound.title.slice(0, 80),
            summary: `${decision.stream.summary || decision.reason} (Follow-up to "${prev.title}", closed ${new Date(closedAt).toLocaleDateString()}.)`,
            labels: decision.stream.labels ?? prev.labels,
            ticketTarget: prev.ticketTarget,
          });
          await this.repo.attachItem(item.id, fresh.id);
          await this.repo.addChat({ streamId: fresh.id, role: 'system', content: `New activity on "${prev.title}", which was closed more than ${days} days ago, so it starts a new work stream.` });
          streamId = fresh.id;
        }
      }
    }
    if (!streamId) return;
    await this.repo.updateStream(streamId, { touch: true, unread: true, ...(decision.updatedSummary ? { summary: decision.updatedSummary } : {}) });
    await this.repo.withdrawStaleClose(streamId, `new activity arrived (${inbound.title.slice(0, 60)})`);
    if (!decision.relevant) return;

    if (decision.notify) {
      bus.publish({ type: 'notify', streamId, title: decision.notify.title, body: decision.notify.body });
      await this.repo.addChat({ streamId, role: 'system', content: `${decision.notify.title}: ${decision.notify.body}` });
    }
    if (decision.next.type === 'draft' && s.claude.autoDraft) {
      void this.runner.run({
        streamId,
        origin: 'system',
        prompt: `[New activity on item ${item.id}: ${inbound.title}]\nTriage says: ${decision.reason}\nPrepare drafts for the PU to review: ${decision.next.instruction}\nThen tell the PU in one or two sentences what you prepared.`,
      });
    } else if (decision.next.type === 'offer' || (decision.next.type === 'draft' && !s.claude.autoDraft)) {
      await this.repo.addChat({
        streamId,
        role: 'suggestion',
        content: decision.next.offerLabel || decision.next.instruction,
        meta: { suggestion: { instruction: decision.next.instruction, status: 'open' } },
      });
    }
  }

  async decide(inbound: InboundItem, existingStreamId: string | null, fresh: ThreadMessage[], s: Settings): Promise<TriageDecision> {
    const people = await this.repo.listPeople();
    const self = people.find((p) => p.email === s.pu.email.toLowerCase()) ?? null;
    const manager = self?.managerEmail ? people.find((p) => p.email === self.managerEmail) : null;
    const reports = self ? people.filter((p) => p.managerEmail === self.email) : [];
    const msgs = inbound.data.messages ?? inbound.data.ticket?.comments ?? [];
    const participants = new Set<string>();
    for (const m of msgs) for (const e of [m.author.email, ...(m.to ?? []), ...(m.cc ?? [])]) if (e) participants.add(e.toLowerCase());
    const known = people.filter((p) => participants.has(p.email)).map((p) => `${p.name} <${p.email}>: ${p.title ?? ''} ${p.department ?? ''}${p.managerEmail ? `, reports to ${p.managerEmail}` : ''}`);
    const open = await this.repo.listStreams(false);

    // Deterministic hint: a top-level Slack DM in a channel where a stream recently posted.
    const hints: string[] = [];
    if (inbound.source === 'slack' && inbound.data.slack && !existingStreamId) {
      const rows = await this.repo.db.selectFrom('items').select(['stream_id', 'data']).where('source', '=', 'slack').where('stream_id', 'is not', null).execute();
      for (const r of rows) if (r.data.includes(`"channel":"${inbound.data.slack.channel}"`)) hints.push(`Stream ${r.stream_id} recently messaged in this same Slack conversation.`);
    }
    const t = inbound.data.ticket;
    const prompt = [
      puBlock(s.pu, { self, manager, reports }),
      known.length ? `People in this conversation (org chart):\n${known.join('\n')}` : '',
      streamsBlock(open),
      existingStreamId ? `This item is ALREADY attached to stream ${existingStreamId}; use action "existing" with that id.` : '',
      hints.join('\n'),
      `Incoming ${inbound.source} ${inbound.kind}: "${inbound.title}" ${inbound.url ?? ''}`,
      t ? `Ticket ${t.key} [${t.flavor}] status=${t.status} assignee=${t.assignee ?? 'unassigned'} requester=${t.requester ?? '?'}\n${(t.description ?? '').slice(0, 2000)}` : '',
      `Earlier context:\n${msgs.filter((m) => !fresh.includes(m)).slice(-4).map(fmt).join('\n\n') || '(none)'}`,
      `NEW activity:\n${fresh.map(fmt).join('\n\n')}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return this.backend.structured({ systemPrompt: TRIAGE_RULES, prompt, schema: TriageDecision });
  }
}
