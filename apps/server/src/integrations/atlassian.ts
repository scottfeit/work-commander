import type { AtlassianSettings, ThreadMessage } from '@wc/shared';
import type { InboundItem, InboundSink, Ingestor, TicketApi } from './types.js';
import { htmlToText } from './types.js';
import type { Repo } from '../core/repo.js';
import type { OutFile } from '../core/attachments.js';

// ---------- Atlassian Document Format helpers ----------
export function adfToText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return node.attrs?.text ?? '@user';
  const inner = (node.content ?? []).map(adfToText).join('');
  if (['paragraph', 'heading', 'blockquote', 'codeBlock'].includes(node.type)) return inner + '\n';
  if (node.type === 'listItem') return `• ${inner}`;
  return inner;
}

/** Plain text to Atlassian Document Format. `mentions` turns each "@Name" into a real mention of that account. */
export function textToAdf(text: string, mentions: { text: string; accountId: string }[] = []) {
  const ms = mentions.filter((m) => m.text && m.accountId).sort((a, b) => b.text.length - a.text.length);
  const re = ms.length ? new RegExp(`(${ms.map((m) => m.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`) : null;
  const inline = (line: string): any[] => {
    if (!re) return line ? [{ type: 'text', text: line }] : [];
    return line
      .split(re)
      .filter(Boolean)
      .map((part) => {
        const m = ms.find((x) => x.text === part);
        return m ? { type: 'mention', attrs: { id: m.accountId, text: m.text } } : { type: 'text', text: part };
      });
  };
  return {
    type: 'doc',
    version: 1,
    content: text.split(/\n{2,}/).map((para) => ({
      type: 'paragraph',
      content: para.split('\n').flatMap((line, i, arr) => [...inline(line), ...(i < arr.length - 1 ? [{ type: 'hardBreak' }] : [])]),
    })),
  };
}

const FIELDS = ['summary', 'status', 'assignee', 'reporter', 'description', 'comment', 'updated', 'project', 'issuetype', 'created', 'attachment'];

export class AtlassianCloud implements TicketApi {
  private base: string;
  private auth: string;
  private me?: { accountId: string; email?: string; displayName: string };
  constructor(siteUrl: string, email: string, token: string, private fetchImpl: typeof fetch = fetch) {
    this.base = siteUrl.replace(/\/$/, '');
    this.auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  }

  async req<T = any>(method: string, path: string, body?: unknown, absolute = false): Promise<T> {
    const r = await this.fetchImpl(absolute ? path : this.base + path, {
      method,
      headers: { Authorization: this.auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-ExperimentalApi': 'opt-in' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`Atlassian ${method} ${path} -> ${r.status}: ${(await r.text()).slice(0, 500)}`);
    if (r.status === 204) return undefined as T;
    const t = await r.text();
    return (t ? JSON.parse(t) : undefined) as T;
  }

  /** Multipart upload (Jira attachments, JSM temporary files). Atlassian requires X-Atlassian-Token: no-check. */
  private async upload<T = any>(path: string, files: OutFile[]): Promise<T> {
    const form = new FormData();
    for (const f of files) form.append('file', new Blob([new Uint8Array(f.data)], { type: f.mimeType }), f.filename);
    const r = await this.fetchImpl(this.base + path, {
      method: 'POST',
      headers: { Authorization: this.auth, Accept: 'application/json', 'X-Atlassian-Token': 'no-check', 'X-ExperimentalApi': 'opt-in' },
      body: form,
    });
    if (!r.ok) throw new Error(`Atlassian upload ${path} -> ${r.status}: ${(await r.text()).slice(0, 500)}`);
    return (await r.json()) as T;
  }

  async attach(input: { key: string; files: OutFile[] }) {
    if (!input.files.length) return { count: 0 };
    const r = await this.upload<unknown[]>(`/rest/api/3/issue/${input.key}/attachments`, input.files);
    return { count: Array.isArray(r) ? r.length : input.files.length };
  }

  async myself() {
    if (!this.me) {
      const r = await this.req('GET', '/rest/api/3/myself');
      this.me = { accountId: r.accountId, email: r.emailAddress, displayName: r.displayName };
    }
    return this.me;
  }

  async accountIdForEmail(email: string): Promise<string | null> {
    const r = await this.req<any[]>('GET', `/rest/api/3/user/search?query=${encodeURIComponent(email)}`);
    const hit = r.find((u) => (u.emailAddress ?? '').toLowerCase() === email.toLowerCase()) ?? r[0];
    return hit?.accountId ?? null;
  }

  issueUrl(key: string) {
    return `${this.base}/browse/${key}`;
  }

  toInbound(issue: any, triggerId?: string): InboundItem {
    const f = issue.fields ?? {};
    const isJsm = !!f.project?.projectTypeKey && f.project.projectTypeKey === 'service_desk';
    const comments: ThreadMessage[] = (f.comment?.comments ?? []).map((c: any) => ({
      id: `c${c.id}`,
      author: { name: c.author?.displayName, email: c.author?.emailAddress, accountId: c.author?.accountId },
      text: adfToText(c.body).trim(),
      at: c.created,
      isFromPU: this.me ? c.author?.accountId === this.me.accountId : false,
    }));
    const lastComment = comments[comments.length - 1];
    return {
      source: isJsm ? 'jsm' : 'jira',
      kind: 'ticket',
      externalId: issue.key,
      title: `${issue.key}: ${f.summary ?? ''}`,
      url: this.issueUrl(issue.key),
      data: {
        ticket: {
          key: issue.key,
          summary: f.summary ?? '',
          status: f.status?.name ?? '',
          assignee: f.assignee?.displayName,
          reporter: f.reporter?.displayName,
          requester: f.reporter?.emailAddress ?? f.reporter?.displayName,
          description: adfToText(f.description).trim(),
          flavor: isJsm ? 'jsm' : 'jira',
          comments,
          attachments: (f.attachment ?? []).filter((a: any) => a?.id && a.content).map((a: any) => ({ id: String(a.id), name: String(a.filename ?? 'file'), mimeType: String(a.mimeType ?? 'application/octet-stream'), size: typeof a.size === 'number' ? a.size : undefined, ref: String(a.content) })),
        },
      },
      eventId: triggerId ?? `${issue.key}@${f.updated ?? lastComment?.id}`,
    };
  }

  /** An attachment's bytes (its content URL on this site; Atlassian may redirect to its media store). */
  async download(url: string): Promise<Buffer> {
    if (!url.startsWith(this.base + '/')) throw new Error('Not an attachment on this Atlassian site');
    const r = await this.fetchImpl(url, { headers: { Authorization: this.auth } });
    if (!r.ok) throw new Error(`Jira attachment: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async getIssue(key: string) {
    await this.myself();
    const issue = await this.req('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(',')}`);
    return this.toInbound(issue);
  }

  async searchIssues(jql: string, max = 25) {
    const r = await this.req('POST', '/rest/api/3/search/jql', { jql, maxResults: max, fields: FIELDS });
    return (r.issues ?? []) as any[];
  }

  async search(jql: string, max = 20) {
    return (await this.searchIssues(jql, max)).map((i) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status?.name, updated: i.fields.updated }));
  }

  private async customerAccountId(email: string) {
    const existing = await this.accountIdForEmail(email);
    if (existing) return existing;
    const c = await this.req('POST', '/rest/servicedeskapi/customer', { email, displayName: email });
    return c.accountId as string;
  }

  async createJsmRequest(input: { serviceDeskId: string; requestTypeId: string; summary: string; description: string; requesterEmail: string; assignToSelf: boolean }) {
    const raiseOnBehalfOf = await this.customerAccountId(input.requesterEmail);
    const r = await this.req('POST', '/rest/servicedeskapi/request', {
      serviceDeskId: input.serviceDeskId,
      requestTypeId: input.requestTypeId,
      requestFieldValues: { summary: input.summary, description: input.description },
      raiseOnBehalfOf,
    });
    const key = r.issueKey as string;
    if (input.assignToSelf) await this.req('PUT', `/rest/api/3/issue/${key}/assignee`, { accountId: (await this.myself()).accountId });
    return { key, url: this.issueUrl(key) };
  }

  async createJiraIssue(input: { projectKey: string; issueType: string; summary: string; description: string; requesterEmail?: string; assignToSelf: boolean }) {
    const me = await this.myself();
    const reporter = input.requesterEmail ? await this.accountIdForEmail(input.requesterEmail) : null;
    const fields: any = {
      project: { key: input.projectKey },
      issuetype: { name: input.issueType },
      summary: input.summary,
      description: textToAdf(input.description),
    };
    if (input.assignToSelf) fields.assignee = { accountId: me.accountId };
    if (reporter) fields.reporter = { accountId: reporter };
    let r;
    try {
      r = await this.req('POST', '/rest/api/3/issue', { fields });
    } catch (e: any) {
      // Projects without "Modify reporter" permission reject the reporter field; retry without it.
      if (!reporter || !/reporter/i.test(e.message)) throw e;
      delete fields.reporter;
      fields.description = textToAdf(`Requested by: ${input.requesterEmail}\n\n${input.description}`);
      r = await this.req('POST', '/rest/api/3/issue', { fields });
    }
    return { key: r.key as string, url: this.issueUrl(r.key) };
  }

  async comment(input: { key: string; body: string; public: boolean; flavor: 'jsm' | 'jira'; files?: OutFile[]; mentions?: { name: string; email?: string }[] }) {
    // "@Name" mentions become real ones: JSM's plain-text body takes [~accountid:…], a Jira comment takes ADF mention nodes.
    const found: { text: string; accountId: string }[] = [];
    for (const m of input.mentions ?? []) {
      const id = m.email ? await this.accountIdForEmail(m.email).catch(() => null) : null;
      if (id && input.body.includes(`@${m.name}`)) found.push({ text: `@${m.name}`, accountId: id });
    }
    if (input.flavor === 'jsm') for (const f of found) input = { ...input, body: input.body.split(f.text).join(`[~accountid:${f.accountId}]`) };
    if (input.flavor === 'jsm' && input.files?.length) {
      // JSM: upload as temporary files, then add them to the request with the comment in one step,
      // so the customer sees the files on a public reply (Jira-API attachments are agent-only).
      const req = await this.req('GET', `/rest/servicedeskapi/request/${input.key}`);
      const tmp = await this.upload<{ temporaryAttachments: { temporaryAttachmentId: string }[] }>(`/rest/servicedeskapi/servicedesk/${req.serviceDeskId}/attachTemporaryFile`, input.files);
      const r = await this.req('POST', `/rest/servicedeskapi/request/${input.key}/attachment`, {
        temporaryAttachmentIds: tmp.temporaryAttachments.map((t) => t.temporaryAttachmentId),
        public: input.public,
        additionalComment: { body: input.body },
      });
      return { id: String(r?.comment?.id ?? '') };
    }
    if (input.flavor === 'jsm') {
      const r = await this.req('POST', `/rest/servicedeskapi/request/${input.key}/comment`, { body: input.body, public: input.public });
      return { id: String(r.id) };
    }
    const r = await this.req('POST', `/rest/api/3/issue/${input.key}/comment`, { body: textToAdf(input.body, found) });
    if (input.files?.length) await this.attach({ key: input.key, files: input.files });
    return { id: String(r.id) };
  }

  async transitionOptions(key: string) {
    const r = await this.req('GET', `/rest/api/3/issue/${key}/transitions?expand=transitions.fields`);
    return ((r.transitions ?? []) as any[]).map((t) => ({
      id: String(t.id),
      name: String(t.name),
      to: String(t.to?.name ?? t.name),
      // only what Jira insists on and won't fill in itself
      fields: Object.entries((t.fields ?? {}) as Record<string, any>)
        .filter(([, f]) => f?.required && !f?.hasDefaultValue)
        .map(([k, f]) => ({ key: k, name: String(f.name ?? k), ...(Array.isArray(f.allowedValues) ? { allowed: f.allowedValues.map((v: any) => ({ id: String(v.id), name: String(v.name ?? v.value ?? v.id) })) } : {}) })),
    }));
  }

  async transition(input: { key: string; to: string; id?: string; resolution?: string; fields?: Record<string, string | { id: string }> }) {
    const r = await this.req('GET', `/rest/api/3/issue/${input.key}/transitions`);
    const want = input.to.toLowerCase();
    const t = (r.transitions as any[]).find((x) => (input.id ? String(x.id) === input.id : x.name.toLowerCase() === want || x.to?.name?.toLowerCase() === want));
    if (!t) throw new Error(`No transition "${input.id ?? input.to}" on ${input.key} now. Available: ${(r.transitions as any[]).map((x) => x.name).join(', ')}`);
    const body: any = { transition: { id: t.id } };
    if (input.resolution) body.fields = { resolution: { name: input.resolution } };
    if (input.fields && Object.keys(input.fields).length) body.fields = { ...(body.fields ?? {}), ...input.fields };
    await this.req('POST', `/rest/api/3/issue/${input.key}/transitions`, body);
    return { status: t.to?.name ?? t.name };
  }

  async assigneeOf(key: string): Promise<string | null> {
    const r = await this.req('GET', `/rest/api/3/issue/${key}?fields=assignee`);
    return r?.fields?.assignee?.accountId ?? null;
  }

  async assign(input: { key: string; assignee: string | null }) {
    let accountId: string | null = null;
    let name: string | null = null;
    if (input.assignee?.startsWith('accountId:')) {
      accountId = input.assignee.slice('accountId:'.length);
      name = accountId;
    } else if (input.assignee === 'me') {
      const me = await this.myself();
      accountId = me.accountId;
      name = me.displayName;
    } else if (input.assignee) {
      accountId = await this.accountIdForEmail(input.assignee);
      if (!accountId) throw new Error(`No Jira user found for ${input.assignee}`);
      name = input.assignee;
    }
    await this.req('PUT', `/rest/api/3/issue/${input.key}/assignee`, { accountId });
    return { assignee: name };
  }

  async linkIssues(input: { keys: string[]; to: string; relation: string }) {
    const types = ((await this.req('GET', '/rest/api/3/issueLinkType')).issueLinkTypes ?? []) as { name: string; inward: string; outward: string }[];
    const want = (input.relation || 'relates to').trim().toLowerCase();
    const pick = resolveLinkType(types, want);
    if (!pick) throw new Error(`No Jira link type matches "${input.relation}". This site has: ${types.map((t) => `${t.outward} / ${t.inward}`).join('; ')}`);
    const linked: string[] = [];
    for (const key of input.keys) {
      // Jira's issueLink: the inwardIssue is the one the link's outward description is said of ("A blocks B": inward A, outward B).
      const [a, b] = pick.reverse ? [input.to, key] : [key, input.to];
      await this.req('POST', '/rest/api/3/issueLink', { type: { name: pick.type.name }, inwardIssue: { key: a }, outwardIssue: { key: b } });
      linked.push(`${key} ${pick.reverse ? pick.type.inward : pick.type.outward} ${input.to}`);
    }
    return { type: pick.type.name, linked };
  }

  async confluenceSearch(query: string, max = 10) {
    const cql = `type=page AND text ~ "${query.replace(/"/g, '\\"')}"`;
    const r = await this.req('GET', `/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${max}`);
    return (r.results ?? []).map((x: any) => ({
      id: x.content?.id,
      title: x.title ?? x.content?.title,
      url: `${this.base}/wiki${x.url ?? x.content?._links?.webui ?? ''}`,
      excerpt: htmlToText(x.excerpt ?? ''),
    }));
  }

  async confluenceRead(pageId: string) {
    const r = await this.req('GET', `/wiki/api/v2/pages/${pageId}?body-format=storage`);
    return { title: r.title, text: htmlToText(r.body?.storage?.value ?? '').slice(0, 60_000), url: `${this.base}/wiki${r._links?.webui ?? ''}` };
  }

  async listServiceDesks() {
    const r = await this.req('GET', '/rest/servicedeskapi/servicedesk?limit=100');
    return (r.values ?? []).map((d: any) => ({ id: String(d.id), projectKey: d.projectKey, name: d.projectName }));
  }

  async listRequestTypes(serviceDeskId: string) {
    const r = await this.req('GET', `/rest/servicedeskapi/servicedesk/${serviceDeskId}/requesttype?limit=100`);
    return (r.values ?? []).map((t: any) => ({ id: String(t.id), name: t.name }));
  }
}

/**
 * Jira ingestion. Polling runs the PU's JQL plus any tickets attached to open streams.
 * Real-time accepts Jira webhooks at /api/webhooks/jira (needs a URL Jira can reach, i.e. GCP
 * hosting or a tunnel); a slow safety poll keeps running alongside.
 */
export class JiraIngestor implements Ingestor {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(
    private api: AtlassianCloud,
    private s: AtlassianSettings,
    private repo: Repo,
    private trackedKeys: () => Promise<string[]>,
    private sink: InboundSink,
    private status: (ok: boolean, msg: string) => void,
  ) {}

  async start() {
    if (this.s.ingestion === 'off') return;
    await this.pollOnce();
    const every = this.s.ingestion === 'realtime' ? 15 * 60 : Math.max(30, this.s.pollSeconds);
    this.timer = setInterval(() => void this.pollOnce(), every * 1000);
  }
  async stop() {
    clearInterval(this.timer);
  }

  async handleWebhook(payload: any) {
    const key = payload?.issue?.key;
    if (!key) return;
    const item = await this.api.getIssue(key);
    const commentId = payload?.comment?.id ? `c${payload.comment.id}` : undefined;
    await this.sink({ ...item, eventId: `${key}@${commentId ?? payload.timestamp ?? Date.now()}` });
  }

  async pollOnce() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.api.myself();
      const since = (await this.repo.getSync('jira.since')) || new Date(Date.now() - 3 * 86400_000).toISOString();
      const startedAt = new Date().toISOString();
      const tracked = await this.trackedKeys();
      const base = tracked.length ? `((${this.s.jql}) OR key in (${tracked.join(',')}))` : `(${this.s.jql})`;
      // Relative minutes avoid JQL interpreting absolute times in the Jira user's time zone.
      const minutes = Math.ceil((Date.now() - Date.parse(since)) / 60_000) + 2;
      const issues = await this.api.searchIssues(`${base} AND updated >= -${minutes}m ORDER BY updated ASC`, 50);
      for (const i of issues) await this.sink(this.api.toInbound(i));
      // A full page means there may be more: the bookmark only moves as far as what was read (oldest first), so the next poll
      // carries on from there and nothing in a long gap is skipped.
      const lastUpdated = issues[issues.length - 1]?.fields?.updated;
      await this.repo.setSync('jira.since', issues.length >= 50 && lastUpdated ? new Date(Date.parse(lastUpdated) - 60_000).toISOString() : startedAt);
      this.status(true, 'Jira synced');
    } catch (e: any) {
      this.status(false, `Jira: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Which link type (and direction) a relation means: "blocks" is a type's outward description, "is blocked by" its inward one
 * (so the link goes the other way), or a type's own name ("Relates", "Blocks"). Case and spacing don't matter.
 */
export function resolveLinkType<T extends { name: string; inward: string; outward: string }>(types: T[], relation: string): { type: T; reverse: boolean } | null {
  const n = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const r = n(relation);
  for (const t of types) if (n(t.outward) === r) return { type: t, reverse: false };
  for (const t of types) if (n(t.inward) === r) return { type: t, reverse: true };
  for (const t of types) if (n(t.name) === r) return { type: t, reverse: false };
  if (/^(relate|link)/.test(r)) {
    const rel = types.find((t) => /^relate/i.test(t.name));
    if (rel) return { type: rel, reverse: false };
  }
  return null;
}
