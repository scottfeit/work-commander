import { nanoid } from 'nanoid';
import type {
  ChatMessage,
  EditableField,
  ItemData,
  ThreadMessage,
  Person,
  Proposal,
  ProposalKind,
  ProposalStatus,
  StreamItem,
  SystemId,
  TicketTarget,
  WorkStream,
} from '@wc/shared';
import type { Database, DB } from '../db/index.js';
import { j, now, pj } from '../db/index.js';
import { bus } from './bus.js';

/** Where a draft goes: two pending drafts with the same target are versions of one message. null = not comparable. */
export function draftTarget(p: { kind: string; system: string; payload: Record<string, any> }): string | null {
  const x = p.payload ?? {};
  switch (p.kind) {
    case 'email_reply':
      return x.thread_id ? `email_reply:${x.thread_id}` : null;
    case 'slack_post':
      return `slack:${x.channel ?? x.recipient_email ?? ''}:${x.thread_ts ?? ''}`;
    case 'ticket_comment':
      return x.key ? `ticket_comment:${x.key}:${x.visibility ?? ''}` : null;
    case 'mcp_tool_call': {
      // Messaging tools: same tool to the same conversation.
      const a = x.args ?? {};
      const where = a.channel_id ?? a.channel ?? a.thread_id ?? a.issueIdOrKey ?? a.key;
      return where ? `mcp:${x.server}:${String(x.tool).replace(/_?drafts?/i, '')}:${where}:${a.thread_ts ?? ''}` : null;
    }
    default:
      return null;
  }
}

export type SummaryAuthor = 'claude' | 'you';

type StreamRow = DB['streams'];
type ItemRow = DB['items'];
type ProposalRow = DB['proposals'];

/** Data access for streams, items, proposals and chat. Every mutation publishes a bus event. */
export class Repo {
  private runStates = new Map<string, WorkStream['runState']>();
  constructor(public db: Database) {}

  // ---------- streams ----------
  private async toStream(r: StreamRow): Promise<WorkStream> {
    const pending = await this.db
      .selectFrom('proposals')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('stream_id', '=', r.id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    const pendingN = Number(pending?.n ?? 0);
    const rs = this.runStates.get(r.id) ?? 'idle';
    return {
      id: r.id,
      title: r.title,
      summary: r.summary,
      status: r.status as WorkStream['status'],
      labels: pj(r.labels, []),
      ticketTarget: pj<TicketTarget | undefined>(r.ticket_target, undefined),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      closedAt: r.closed_at,
      lastActivityAt: r.last_activity_at,
      pendingProposals: pendingN,
      unread: !!r.unread,
      runState: rs === 'idle' && pendingN > 0 ? 'waiting_approval' : rs,
    };
  }

  async listStreams(includeClosed: boolean) {
    let q = this.db.selectFrom('streams').selectAll().orderBy('last_activity_at', 'desc');
    if (!includeClosed) q = q.where('status', '=', 'open');
    return Promise.all((await q.execute()).map((r) => this.toStream(r)));
  }

  async getStream(id: string) {
    const r = await this.db.selectFrom('streams').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? this.toStream(r) : null;
  }

  async getStreamRow(id: string) {
    return this.db.selectFrom('streams').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async createStream(input: { title: string; summary: string; labels?: string[]; ticketTarget?: TicketTarget }, by: SummaryAuthor = 'claude') {
    const t = now();
    const row: StreamRow = {
      id: nanoid(10),
      title: input.title,
      summary: input.summary,
      status: 'open',
      labels: j(input.labels ?? []),
      ticket_target: input.ticketTarget ? j(input.ticketTarget) : null,
      agent_session_id: null,
      unread: 1,
      created_at: t,
      updated_at: t,
      closed_at: null,
      last_activity_at: t,
    };
    await this.db.insertInto('streams').values(row).execute();
    await this.db.insertInto('stream_summaries').values({ stream_id: row.id, summary: row.summary, by, at: t }).execute();
    const s = await this.toStream(row);
    bus.publish({ type: 'stream.updated', stream: s });
    return s;
  }

  async updateStream(
    id: string,
    patch: Partial<{ title: string; summary: string; status: 'open' | 'closed'; labels: string[]; ticketTarget: TicketTarget | null; unread: boolean; agentSessionId: string | null; touch: boolean }>,
    by: SummaryAuthor = 'claude',
  ) {
    const t = now();
    if (patch.summary !== undefined) await this.recordSummary(id, patch.summary, by, t);
    const set: Partial<StreamRow> = { updated_at: t };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.summary !== undefined) set.summary = patch.summary;
    if (patch.status !== undefined) {
      set.status = patch.status;
      set.closed_at = patch.status === 'closed' ? t : null;
    }
    if (patch.labels !== undefined) set.labels = j(patch.labels);
    if (patch.ticketTarget !== undefined) set.ticket_target = patch.ticketTarget ? j(patch.ticketTarget) : null;
    if (patch.unread !== undefined) set.unread = patch.unread ? 1 : 0;
    if (patch.agentSessionId !== undefined) set.agent_session_id = patch.agentSessionId;
    if (patch.touch) set.last_activity_at = t;
    await this.db.updateTable('streams').set(set).where('id', '=', id).execute();
    await this.emitStream(id);
  }

  /** Keep every version of the Overview. Streams created before history existed get their old summary saved undated first. */
  private async recordSummary(id: string, next: string, by: SummaryAuthor, at: string) {
    const cur = await this.db.selectFrom('streams').select('summary').where('id', '=', id).executeTakeFirst();
    if (!cur || cur.summary === next) return;
    const has = await this.db.selectFrom('stream_summaries').select('id').where('stream_id', '=', id).limit(1).executeTakeFirst();
    if (!has && cur.summary) await this.db.insertInto('stream_summaries').values({ stream_id: id, summary: cur.summary, by: 'unknown', at: null }).execute();
    await this.db.insertInto('stream_summaries').values({ stream_id: id, summary: next, by, at }).execute();
  }

  /** All versions of a stream's Overview, newest first (the first is the current one). */
  async listSummaries(id: string) {
    const rows = await this.db.selectFrom('stream_summaries').selectAll().where('stream_id', '=', id).orderBy('id', 'desc').execute();
    return rows.map((r) => ({ id: r.id, summary: r.summary, by: r.by as SummaryAuthor | 'unknown', at: r.at }));
  }

  // ---------- Claude Code hand-offs ----------
  async createHandoff(streamId: string, folder: string) {
    const row = { id: nanoid(10), stream_id: streamId, folder, created_at: now(), result_mtime: null, returned_at: null };
    await this.db.insertInto('handoffs').values(row).execute();
    return row;
  }
  listHandoffs() {
    return this.db.selectFrom('handoffs').selectAll().execute();
  }
  latestHandoff(streamId: string) {
    return this.db.selectFrom('handoffs').selectAll().where('stream_id', '=', streamId).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  }
  async markHandoffReturned(id: string, resultMtime: string) {
    await this.db.updateTable('handoffs').set({ result_mtime: resultMtime, returned_at: now() }).where('id', '=', id).execute();
  }
  /** Hand-offs made before they were tracked are only in the audit log; adopt them so their results still come back. */
  async adoptLoggedHandoffs() {
    const known = new Set((await this.listHandoffs()).map((h) => `${h.stream_id}|${h.folder}`));
    const logged = await this.db.selectFrom('audit_log').selectAll().where('action', '=', 'stream.handoff').orderBy('id', 'asc').execute();
    for (const a of logged) {
      const d = pj<{ streamId?: string; folder?: string }>(a.detail, {});
      if (!d.streamId || !d.folder || known.has(`${d.streamId}|${d.folder}`)) continue;
      known.add(`${d.streamId}|${d.folder}`);
      await this.db.insertInto('handoffs').values({ id: nanoid(10), stream_id: d.streamId, folder: d.folder, created_at: a.at, result_mtime: null, returned_at: null }).execute();
    }
  }

  async emitStream(id: string | null) {
    if (!id) return;
    const s = await this.getStream(id);
    if (s) bus.publish({ type: 'stream.updated', stream: s });
  }

  setRunState(streamId: string | null, state: WorkStream['runState']) {
    if (!streamId) return;
    this.runStates.set(streamId, state);
    void this.emitStream(streamId);
  }

  // ---------- items ----------
  private toItem(r: ItemRow): StreamItem {
    return {
      id: r.id,
      streamId: r.stream_id,
      source: r.source as StreamItem['source'],
      kind: r.kind as StreamItem['kind'],
      externalId: r.external_id,
      title: r.title,
      url: r.url ?? undefined,
      data: pj<ItemData>(r.data, {}),
      updatedAt: r.updated_at,
    };
  }

  async listItems(streamId: string) {
    const rows = await this.db.selectFrom('items').selectAll().where('stream_id', '=', streamId).orderBy('updated_at', 'asc').execute();
    return rows.map((r) => this.toItem(r));
  }

  async getItem(id: string) {
    const r = await this.db.selectFrom('items').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? this.toItem(r) : null;
  }

  async findItem(source: string, externalId: string) {
    const r = await this.db.selectFrom('items').selectAll().where('source', '=', source).where('external_id', '=', externalId).executeTakeFirst();
    return r ? this.toItem(r) : null;
  }

  /**
   * Insert or update an item by (source, externalId). Thread messages are merged by id so repeated
   * ingestion is idempotent. Returns the item and the messages that were new.
   */
  async upsertItem(input: Omit<StreamItem, 'id' | 'updatedAt' | 'streamId'> & { streamId?: string | null }) {
    const existing = await this.findItem(input.source, input.externalId);
    const t = now();
    if (!existing) {
      const row: ItemRow = {
        id: nanoid(12),
        stream_id: input.streamId ?? null,
        source: input.source,
        kind: input.kind,
        external_id: input.externalId,
        title: input.title,
        url: input.url ?? null,
        data: j(input.data),
        updated_at: t,
      };
      await this.db.insertInto('items').values(row).execute();
      const item = this.toItem(row);
      bus.publish({ type: 'item.updated', item });
      return { item, newMessages: input.data.messages ?? [], created: true, changed: true };
    }
    const prev = existing.data;
    const incoming = input.data.messages ?? [];
    // A locally recorded copy of something the PU sent ("sent-…") gives way to the real message once it arrives.
    const same = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
    if (prev.messages?.some((m) => m.id.startsWith('sent-')))
      prev.messages = prev.messages.filter((m) => !(m.id.startsWith('sent-') && incoming.some((x) => x.isFromPU && same(x.text, m.text))));
    const known = new Set((prev.messages ?? []).map((m) => m.id));
    const newMessages = incoming.filter((m) => !known.has(m.id));
    const messages = [...(prev.messages ?? []), ...newMessages].sort((a, b) => a.at.localeCompare(b.at));
    let ticket = input.data.ticket ?? prev.ticket;
    const ticketChanged = !!(prev.ticket && input.data.ticket && (prev.ticket.status !== input.data.ticket.status || prev.ticket.assignee !== input.data.ticket.assignee));
    if (prev.ticket && input.data.ticket) {
      const knownC = new Set(prev.ticket.comments.map((c) => c.id));
      const newComments = input.data.ticket.comments.filter((c) => !knownC.has(c.id));
      newMessages.push(...newComments);
      ticket = { ...input.data.ticket, comments: [...prev.ticket.comments, ...newComments] };
    }
    const data: ItemData = { ...prev, ...input.data, messages: messages.length ? messages : undefined, ticket };
    const streamId = existing.streamId ?? input.streamId ?? null;
    await this.db
      .updateTable('items')
      .set({ title: input.title || existing.title, url: input.url ?? existing.url ?? null, data: j(data), updated_at: t, stream_id: streamId })
      .where('id', '=', existing.id)
      .execute();
    const item = { ...existing, title: input.title || existing.title, data, updatedAt: t, streamId };
    bus.publish({ type: 'item.updated', item });
    return { item, newMessages, created: false, changed: newMessages.length > 0 || ticketChanged };
  }

  /**
   * Add a message the PU just sent through an MCP server to the stream's matching conversation item.
   * MCP servers give no reliable way to re-fetch the thread, so this records it until the next poll brings the real copy.
   */
  async recordSentMessage(streamId: string, source: 'slack', match: { channel: string; threadTs?: string }, text: string, id: string, pu: { name?: string; email?: string }) {
    const items = (await this.listItems(streamId)).filter((i) => i.source === source && i.data.slack?.channel === match.channel);
    const it = (match.threadTs ? items.find((i) => i.data.slack?.threadTs === match.threadTs) : undefined) ?? items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!it) return null;
    const m: ThreadMessage = { id: `sent-${id}`, author: { name: pu.name, email: pu.email }, text, at: now(), isFromPU: true };
    const data: ItemData = { ...it.data, messages: [...(it.data.messages ?? []), m] };
    const t = now();
    await this.db.updateTable('items').set({ data: j(data), updated_at: t }).where('id', '=', it.id).execute();
    const item = { ...it, data, updatedAt: t };
    bus.publish({ type: 'item.updated', item });
    return item;
  }

  async attachItem(itemId: string, streamId: string) {
    await this.db.updateTable('items').set({ stream_id: streamId, updated_at: now() }).where('id', '=', itemId).execute();
    const item = await this.getItem(itemId);
    if (item) bus.publish({ type: 'item.updated', item });
  }

  // ---------- proposals ----------
  private toProposal(r: ProposalRow): Proposal {
    return {
      id: r.id,
      streamId: r.stream_id,
      runId: r.run_id,
      kind: r.kind as ProposalKind,
      system: r.system as Proposal['system'],
      title: r.title,
      rationale: r.rationale,
      payload: pj(r.payload, {}),
      originalPayload: pj(r.original_payload, {}),
      editable: pj<EditableField[]>(r.editable, []),
      dependsOn: pj<string[]>(r.depends_on, []),
      status: r.status as ProposalStatus,
      result: pj(r.result, null),
      error: r.error,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      executedAt: r.executed_at,
    };
  }

  async createProposal(input: {
    streamId: string | null;
    runId: string;
    kind: ProposalKind;
    system: SystemId | 'internal';
    title: string;
    rationale: string;
    payload: Record<string, unknown>;
    editable: EditableField[];
    dependsOn?: string[];
  }) {
    const row: ProposalRow = {
      id: `p_${nanoid(8)}`,
      stream_id: input.streamId,
      run_id: input.runId,
      kind: input.kind,
      system: input.system,
      title: input.title,
      rationale: input.rationale,
      payload: j(input.payload),
      original_payload: j(input.payload),
      editable: j(input.editable),
      depends_on: j(input.dependsOn ?? []),
      status: 'pending',
      result: null,
      error: null,
      created_at: now(),
      decided_at: null,
      executed_at: null,
    };
    await this.db.insertInto('proposals').values(row).execute();
    const p = this.toProposal(row);
    bus.publish({ type: 'proposal.updated', proposal: p });
    await this.emitStream(input.streamId);
    // New work on a stream means it isn't finished: drop a close suggestion from an earlier turn.
    if (p.streamId && p.kind !== 'stream_close') await this.withdrawStaleClose(p.streamId, 'Claude started more work on this stream', p.runId);
    // A new draft to the same place from a later turn replaces the older unsent one (e.g. "change that reply").
    const target = draftTarget(p);
    if (target) {
      const older = (await this.listProposals({ streamId: p.streamId, status: ['pending'] })).filter((x) => x.id !== p.id && x.runId !== p.runId && draftTarget(x) === target);
      await this.withdrawProposals(older.map((x) => x.id), `replaced by the new draft "${p.title}"`);
    }
    return p;
  }

  async getProposal(id: string) {
    const r = await this.db.selectFrom('proposals').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? this.toProposal(r) : null;
  }

  async listProposals(filter: { streamId?: string | null; status?: ProposalStatus[]; runId?: string }) {
    let q = this.db.selectFrom('proposals').selectAll().orderBy('created_at', 'asc');
    if (filter.streamId !== undefined) q = filter.streamId === null ? q.where('stream_id', 'is', null) : q.where('stream_id', '=', filter.streamId);
    if (filter.status) q = q.where('status', 'in', filter.status);
    if (filter.runId) q = q.where('run_id', '=', filter.runId);
    return (await q.execute()).map((r) => this.toProposal(r));
  }

  /** Withdraw pending drafts (never ones already approved or sent), noting it in their stream's chat. */
  async withdrawProposals(ids: string[], why: string) {
    let n = 0;
    for (const id of ids) {
      const x = await this.getProposal(id);
      if (!x || x.status !== 'pending') continue;
      await this.updateProposal(x.id, { status: 'withdrawn', error: why });
      await this.audit('system', 'proposal.withdrawn', { id: x.id, kind: x.kind, why });
      if (x.streamId) {
        await this.addChat({ streamId: x.streamId, role: 'system', content: `Draft "${x.title}" withdrawn: ${why}.` });
        await this.emitStream(x.streamId);
      }
      n++;
    }
    return n;
  }

  /** Withdraw pending "close this stream" suggestions (except ones from `keepRunId`, the turn that is proposing more work alongside them). */
  async withdrawStaleClose(streamId: string, why: string, keepRunId?: string) {
    const stale = (await this.listProposals({ streamId, status: ['pending'] })).filter((x) => x.kind === 'stream_close' && x.runId !== keepRunId);
    for (const x of stale) {
      await this.updateProposal(x.id, { status: 'withdrawn', error: why });
      await this.audit('system', 'proposal.withdrawn', { id: x.id, kind: x.kind, why });
    }
    if (stale.length) {
      await this.emitStream(streamId);
      await this.addChat({ streamId, role: 'system', content: `Close suggestion withdrawn: ${why.charAt(0).toLowerCase() + why.slice(1)}.` });
    }
    return stale.length;
  }

  async updateProposal(id: string, patch: Partial<{ payload: Record<string, unknown>; status: ProposalStatus; result: unknown; error: string | null }>) {
    const set: Partial<ProposalRow> = {};
    if (patch.payload) set.payload = j(patch.payload);
    if (patch.status) {
      set.status = patch.status;
      if (['approved', 'rejected'].includes(patch.status)) set.decided_at = now();
      if (['executed', 'failed'].includes(patch.status)) set.executed_at = now();
    }
    if (patch.result !== undefined) set.result = j(patch.result);
    if (patch.error !== undefined) set.error = patch.error;
    await this.db.updateTable('proposals').set(set).where('id', '=', id).execute();
    const p = (await this.getProposal(id))!;
    bus.publish({ type: 'proposal.updated', proposal: p });
    await this.emitStream(p.streamId);
    return p;
  }

  // ---------- chat ----------
  async addChat(input: { streamId: string | null; role: ChatMessage['role']; content: string; meta?: ChatMessage['meta'] }) {
    const m: ChatMessage = { id: nanoid(12), streamId: input.streamId, role: input.role, content: input.content, meta: input.meta ?? {}, createdAt: now() };
    await this.db.insertInto('chat_messages').values({ id: m.id, stream_id: m.streamId, role: m.role, content: m.content, meta: j(m.meta), created_at: m.createdAt }).execute();
    bus.publish({ type: 'chat.message', message: m });
    return m;
  }

  async updateChatMeta(id: string, meta: ChatMessage['meta']) {
    await this.db.updateTable('chat_messages').set({ meta: j(meta) }).where('id', '=', id).execute();
    const r = await this.db.selectFrom('chat_messages').selectAll().where('id', '=', id).executeTakeFirst();
    if (r) bus.publish({ type: 'chat.message', message: { id: r.id, streamId: r.stream_id, role: r.role as ChatMessage['role'], content: r.content, meta: pj(r.meta, {}), createdAt: r.created_at } });
  }

  async getChat(id: string) {
    const r = await this.db.selectFrom('chat_messages').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? ({ id: r.id, streamId: r.stream_id, role: r.role as ChatMessage['role'], content: r.content, meta: pj(r.meta, {}), createdAt: r.created_at } as ChatMessage) : null;
  }

  async listChat(streamId: string | null, limit = 200) {
    let q = this.db.selectFrom('chat_messages').selectAll().orderBy('created_at', 'asc').limit(limit);
    q = streamId === null ? q.where('stream_id', 'is', null) : q.where('stream_id', '=', streamId);
    return (await q.execute()).map((r) => ({ id: r.id, streamId: r.stream_id, role: r.role as ChatMessage['role'], content: r.content, meta: pj(r.meta, {}), createdAt: r.created_at }) as ChatMessage);
  }

  // ---------- people ----------
  async listPeople() {
    const rows = await this.db.selectFrom('people').selectAll().orderBy('name').execute();
    return rows.map(toPerson);
  }
  async findPersonByEmail(email: string) {
    const r = await this.db.selectFrom('people').selectAll().where('email', '=', email.toLowerCase()).executeTakeFirst();
    return r ? toPerson(r) : null;
  }
  async replacePeople(source: Person['source'], people: Omit<Person, 'id' | 'source'>[]) {
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('people').where('source', '=', source).execute();
      for (const p of people) {
        await tx
          .insertInto('people')
          .values({
            id: nanoid(10),
            name: p.name,
            email: p.email.toLowerCase(),
            title: p.title ?? null,
            department: p.department ?? null,
            manager_email: p.managerEmail?.toLowerCase() ?? null,
            slack_user_id: p.slackUserId ?? null,
            atlassian_account_id: p.atlassianAccountId ?? null,
            source,
          })
          .execute();
      }
    });
  }

  // ---------- sync state & audit ----------
  async getSync(key: string) {
    return (await this.db.selectFrom('sync_state').select('value').where('key', '=', key).executeTakeFirst())?.value ?? null;
  }
  async setSync(key: string, value: string) {
    await this.db.insertInto('sync_state').values({ key, value }).onConflict((oc) => oc.column('key').doUpdateSet({ value })).execute();
  }
  async audit(actor: string, action: string, detail: unknown) {
    await this.db.insertInto('audit_log').values({ at: now(), actor, action, detail: j(detail) }).execute();
  }

  /** Dedupe inbound events by (source, externalId). Returns false if already seen. */
  /** Recent items triage passed over (in no stream), with the reason from their latest triage decision. */
  async listSkipped(days = 14) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = await this.db.selectFrom('items').selectAll().where('stream_id', 'is', null).where('updated_at', '>=', since).orderBy('updated_at', 'desc').limit(50).execute();
    const out = [];
    for (const r of rows) {
      const ev = await this.db.selectFrom('inbound_events').select(['decision', 'processed_at']).where('item_id', '=', r.id).where('processed_at', 'is not', null).orderBy('processed_at', 'desc').limit(1).executeTakeFirst();
      const d = pj<{ reason?: string; skipped?: string }>(ev?.decision, {});
      const it = this.toItem(r);
      const last = (it.data.messages ?? it.data.ticket?.comments ?? []).slice(-1)[0];
      out.push({ id: it.id, source: it.source, title: it.title, updatedAt: it.updatedAt, from: last?.author.name ?? last?.author.email ?? '', reason: d.reason ?? d.skipped ?? '' });
    }
    return out;
  }

  async recordInbound(source: string, externalId: string, itemId: string | null) {
    try {
      await this.db.insertInto('inbound_events').values({ id: nanoid(12), source, external_id: externalId, item_id: itemId, received_at: now(), processed_at: null, relevant: null, decision: null }).execute();
      return true;
    } catch {
      return false;
    }
  }
  async markInbound(source: string, externalId: string, relevant: boolean, decision: unknown) {
    await this.db
      .updateTable('inbound_events')
      .set({ processed_at: now(), relevant: relevant ? 1 : 0, decision: j(decision) })
      .where('source', '=', source)
      .where('external_id', '=', externalId)
      .execute();
  }
}

function toPerson(r: DB['people']): Person {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    title: r.title ?? undefined,
    department: r.department ?? undefined,
    managerEmail: r.manager_email ?? undefined,
    slackUserId: r.slack_user_id ?? undefined,
    atlassianAccountId: r.atlassian_account_id ?? undefined,
    source: r.source as Person['source'],
  };
}
