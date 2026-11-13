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
    case 'ticket_assign':
      return x.key ? `ticket_assign:${x.key}` : null;
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
    const latest = await this.db.selectFrom('items').select('source').where('stream_id', '=', r.id).orderBy('updated_at', 'desc').limit(1).executeTakeFirst();
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
      pending: !!r.pending,
      reminderAt: r.reminder_at,
      lastSource: (latest?.source as WorkStream['lastSource']) ?? undefined,
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
      pending: 0,
      pending_at: null,
      reminder_at: null,
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
    patch: Partial<{ title: string; summary: string; status: 'open' | 'closed'; labels: string[]; ticketTarget: TicketTarget | null; unread: boolean; pending: boolean; agentSessionId: string | null; touch: boolean }>,
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
      if (patch.status === 'closed') {
        set.pending = 0; // a closed stream is done, not waiting
        set.reminder_at = null;
      }
    }
    if (patch.labels !== undefined) set.labels = j(patch.labels);
    if (patch.ticketTarget !== undefined) set.ticket_target = patch.ticketTarget ? j(patch.ticketTarget) : null;
    if (patch.unread !== undefined) set.unread = patch.unread ? 1 : 0;
    if (patch.pending !== undefined) {
      set.pending = patch.pending ? 1 : 0;
      set.pending_at = patch.pending ? t : null;
      set.reminder_at = null; // snoozed again, or new activity: the reminder is answered
    }
    if (patch.agentSessionId !== undefined) set.agent_session_id = patch.agentSessionId;
    if (patch.touch) set.last_activity_at = t;
    await this.db.updateTable('streams').set(set).where('id', '=', id).execute();
    await this.emitStream(id);
  }

  /**
   * A pending stream has sat untouched too long: bring it back to the top of Open as a Reminder and mark the stream (not its
   * work items) unread.
   */
  async surfaceReminder(id: string) {
    const t = now();
    await this.db.updateTable('streams').set({ pending: 0, pending_at: null, reminder_at: t, unread: 1, last_activity_at: t, updated_at: t }).where('id', '=', id).execute();
    await this.emitStream(id);
  }

  /** Open pending streams whose last activity (or the moment they were snoozed, if later) is at least `days` ago. */
  async pendingStreamsDue(days: number, nowMs = Date.now()) {
    if (!(days > 0)) return [];
    const rows = await this.db.selectFrom('streams').selectAll().where('status', '=', 'open').where('pending', '=', 1).execute();
    const cutoff = nowMs - days * 86_400_000;
    return rows.filter((r) => Math.max(Date.parse(r.last_activity_at), r.pending_at ? Date.parse(r.pending_at) : 0) <= cutoff).map((r) => r.id);
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
    // Tabs the PU has arranged keep their order; the rest follow, oldest activity first.
    return rows
      .map((r, i) => ({ it: this.toItem(r), i }))
      .sort((a, b) => (a.it.data.tabOrder ?? Infinity) - (b.it.data.tabOrder ?? Infinity) || a.i - b.i)
      .map((x) => x.it);
  }

  /** New activity on an item in a work stream: flag its tab until the PU opens it. */
  async markItemUnread(itemId: string, force = false) {
    const it = await this.getItem(itemId);
    if (!it?.streamId || it.data.unread || (it.data.muted && !force)) return; // a silenced item raises a dot only when something breaks through
    const data: ItemData = { ...it.data, unread: true };
    await this.db.updateTable('items').set({ data: j(data) }).where('id', '=', itemId).execute();
    bus.publish({ type: 'item.updated', item: { ...it, data } });
  }

  /** Silence (or un-silence) an item's updates. Updates keep arriving; they just stop making noise. */
  async setItemMuted(itemId: string, muted: boolean) {
    const it = await this.getItem(itemId);
    if (!it) throw new Error('Item not found');
    const data: ItemData = { ...it.data, muted: muted || undefined, unread: muted ? undefined : it.data.unread };
    await this.db.updateTable('items').set({ data: j(data) }).where('id', '=', itemId).execute();
    await this.audit('pu', muted ? 'item.silenced' : 'item.unsilenced', { itemId });
    bus.publish({ type: 'item.updated', item: { ...it, data } });
    if (it.streamId) await this.emitStream(it.streamId);
  }

  async markItemRead(itemId: string) {
    const it = await this.getItem(itemId);
    if (!it?.data.unread) return;
    const data: ItemData = { ...it.data, unread: undefined };
    await this.db.updateTable('items').set({ data: j(data) }).where('id', '=', itemId).execute();
    bus.publish({ type: 'item.updated', item: { ...it, data } });
  }

  /** Remember the PU's tab order for a work stream (ids in display order). */
  async setItemOrder(streamId: string, ids: string[]) {
    const at = now();
    for (const [i, id] of ids.entries()) {
      const it = await this.getItem(id);
      if (!it || it.streamId !== streamId) continue;
      const data: ItemData = { ...it.data, tabOrder: i, tabOrderAt: at };
      await this.db.updateTable('items').set({ data: j(data) }).where('id', '=', id).execute();
      bus.publish({ type: 'item.updated', item: { ...it, data } });
    }
  }

  async getItem(id: string) {
    const r = await this.db.selectFrom('items').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? this.toItem(r) : null;
  }

  /** The item an incoming (source, externalId) will land in, if there already is one (same lookup upsertItem does, without writing). */
  async findExistingItem(source: string, externalId: string) {
    const dm = await this.findSlackDmItem(source, externalId);
    const id = dm ? dm.externalId : externalId;
    return (await this.findItem(source, id)) ?? (source === 'slack' ? await this.findAliasItem(id) : null);
  }

  async findAliasItem(externalId: string) {
    const rows = await this.db.selectFrom('items').selectAll().where('source', '=', 'slack').where('data', 'like', `%"${externalId}"%`).execute();
    const hit = rows.map((r) => this.toItem(r)).find((i) => i.data.mergedExternalIds?.includes(externalId));
    return hit ?? null;
  }

  /** The Slack channel an item belongs to (null if it isn't a Slack item). */
  static slackChannelOf(it: { source: string; externalId: string; data: ItemData }) {
    if (it.source !== 'slack') return null;
    return it.data.slack?.channel ?? /^([A-Z][A-Z0-9]{6,})(?::|$)/.exec(it.externalId)?.[1] ?? null;
  }

  /**
   * Slack messages from the same channel that ended up in one work stream are one discussion: fold them into a single item
   * (the earliest), keeping every message and remembering the folded ids so re-ingesting them lands in the same item.
   */
  async mergeSiblingChannelItems(streamId: string) {
    const groups = new Map<string, StreamItem[]>();
    for (const it of await this.listItems(streamId)) {
      const ch = Repo.slackChannelOf(it);
      if (ch) groups.set(ch, [...(groups.get(ch) ?? []), it]);
    }
    let merged = 0;
    for (const [channel, group] of groups) {
      if (group.length < 2) continue;
      const firstAt = (i: StreamItem) => (i.data.messages ?? []).map((m) => m.at).sort()[0] ?? i.updatedAt;
      group.sort((a, b) => firstAt(a).localeCompare(firstAt(b)));
      const [keep, ...rest] = group;
      const messages = new Map((keep.data.messages ?? []).map((m) => [m.id, m]));
      const aliases = new Set([...(keep.data.mergedExternalIds ?? [])]);
      let unread = !!keep.data.unread;
      for (const r of rest) {
        for (const m of r.data.messages ?? []) messages.set(m.id, m);
        aliases.add(r.externalId);
        for (const a of r.data.mergedExternalIds ?? []) aliases.add(a);
        unread = unread || !!r.data.unread;
        await this.db.updateTable('inbound_events').set({ item_id: keep.id }).where('item_id', '=', r.id).execute();
        await this.db.deleteFrom('message_html').where('item_id', '=', r.id).execute();
        await this.db.deleteFrom('items').where('id', '=', r.id).execute();
        bus.publish({ type: 'item.updated', item: { ...r, streamId: null } }); // takes its tab away
        merged++;
      }
      aliases.delete(keep.externalId);
      const label = [keep, ...rest].map((i) => /^(#[^\s:]+)/.exec(i.title)?.[1]).find(Boolean);
      const data: ItemData = {
        ...keep.data,
        messages: [...messages.values()].sort((a, b) => a.at.localeCompare(b.at)),
        mergedExternalIds: [...aliases],
        slack: { channel, channelName: keep.data.slack?.channelName, threadTs: keep.data.slack?.threadTs ?? '' },
        unread: unread || undefined,
      };
      await this.db.updateTable('items').set({ title: label ?? keep.title, data: j(data), updated_at: now() }).where('id', '=', keep.id).execute();
      const item = await this.getItem(keep.id);
      if (item) bus.publish({ type: 'item.updated', item });
    }
    if (merged) await this.emitStream(streamId);
    return merged;
  }

  /** Cleanup pass over every stream (items that were filed before channel discussions were folded together). */
  async mergeAllChannelItems() {
    let n = 0;
    for (const s of await this.listStreams(true)) n += await this.mergeSiblingChannelItems(s.id);
    return n;
  }

  /** The channel id when `externalId` ("D…" or "D…:ts") is a Slack DM. */
  static slackDmChannel(source: string, externalId: string) {
    // D… is a DM; "<channel>:dm" is how the ingestor labels a whole conversation (including group DMs).
    return source === 'slack' ? /^(D[A-Z0-9]+)(?::.*)?$/.exec(externalId)?.[1] ?? /^([A-Z][A-Z0-9]+):dm(?:@.*)?$/.exec(externalId)?.[1] ?? null : null;
  }

  /** Every Slack item of one channel or conversation. A conversation can be split across work streams, one item per stream. */
  async slackFamily(channel: string): Promise<StreamItem[]> {
    const rows = await this.db
      .selectFrom('items')
      .selectAll()
      .where('source', '=', 'slack')
      .where((eb) => eb.or([eb('external_id', '=', channel), eb('external_id', 'like', `${channel}:%`)]))
      .orderBy('updated_at', 'asc')
      .execute();
    return rows.map((r) => this.toItem(r));
  }

  /** A DM or group DM is one flowing conversation (as opposed to a channel, whose threads are separate discussions). */
  static slackIsFlat(channel: string, family: StreamItem[]) {
    return channel.startsWith('D') || family.some((i) => /:dm(?:@.*)?$/.test(i.externalId));
  }

  /**
   * The item new messages of a DM conversation go to by default: the one holding its latest message (so a conversation carries on
   * in the work stream it is currently being discussed in). Which messages belong to which stream is otherwise the PU's call
   * (moving them) or, later, triage's.
   */
  async findSlackDmItem(source: string, externalId: string) {
    let channel = Repo.slackDmChannel(source, externalId);
    if (!channel && source === 'slack') {
      // A group DM has a C… id, so a single message of it ("<channel>:<ts>") looks like a channel thread. If we already hold that
      // conversation as "<channel>:dm" (in a work stream, open or closed), the message belongs there.
      const ch = /^([A-Z][A-Z0-9]+):\d+\.\d+(?:@.*)?$/.exec(externalId)?.[1];
      if (ch && (await this.db.selectFrom('items').select('id').where('source', '=', 'slack').where((eb) => eb.or([eb('external_id', '=', `${ch}:dm`), eb('external_id', 'like', `${ch}:dm@%`)])).executeTakeFirst())) channel = ch;
    }
    if (!channel) return null;
    const family = await this.slackFamily(channel);
    if (!family.length) return null;
    const latest = (i: StreamItem) => (i.data.messages ?? []).map((m) => m.at).sort().pop() ?? '';
    return [...family].sort((a, b) => latest(b).localeCompare(latest(a)) || b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  /**
   * Put Slack messages into a work stream's item for their conversation (creating it), taking them out of whichever item held
   * them before. This is how a conversation is split by topic: each work stream holds only the messages that belong to it.
   * `toStreamId` null puts them in the conversation's "no stream" item (not relevant to any work stream).
   */
  async placeSlackMessages(input: {
    channel: string;
    toStreamId: string | null;
    messages: ThreadMessage[];
    title: string;
    channelName?: string;
    flat?: boolean;
    /** Leave messages that another work stream holds where they are (a link's "later messages" must not pull in other topics). */
    keepOtherStreams?: boolean;
  }) {
    const family = await this.slackFamily(input.channel);
    const flat = input.flat ?? Repo.slackIsFlat(input.channel, family);
    const holderOf = (id: string) => family.find((i) => i.data.messages?.some((m) => m.id === id));
    const todo = input.messages.filter((m) => {
      const h = holderOf(m.id);
      return !(input.keepOtherStreams && h?.streamId && h.streamId !== input.toStreamId);
    });
    if (!todo.length) return { item: null as StreamItem | null, added: 0, moved: [] as { itemId: string; streamId: string | null; title: string; count: number }[] };
    const first = [...todo].sort((a, b) => a.at.localeCompare(b.at))[0];
    let target =
      input.toStreamId !== null
        ? family.find((i) => i.streamId === input.toStreamId)
        : flat
          ? family.find((i) => !i.streamId && Repo.slackChannelOf(i) === input.channel)
          : holderOf(first.id)?.streamId === null
            ? holderOf(first.id)
            : undefined;
    const t = now();
    let created = false;
    if (!target) {
      const base = flat ? `${input.channel}:dm` : `${input.channel}:${first.id}`;
      const taken = new Set(family.map((i) => i.externalId));
      let externalId = !taken.has(base) ? base : `${base}@${input.toStreamId ?? '-'}`;
      for (let n = 2; taken.has(externalId); n++) externalId = `${base}@${input.toStreamId ?? '-'}~${n}`;
      const row: ItemRow = {
        id: nanoid(12),
        stream_id: input.toStreamId,
        source: 'slack',
        kind: 'slack_thread',
        external_id: externalId,
        title: input.title,
        url: null,
        data: j({ messages: [], slack: { channel: input.channel, channelName: input.channelName, threadTs: first.id } } as ItemData),
        updated_at: t,
      };
      await this.db.insertInto('items').values(row).execute();
      target = this.toItem(row);
      created = true;
    }
    const aliases = new Set(target.data.mergedExternalIds ?? []);
    const moved = new Map<string, { itemId: string; streamId: string | null; title: string; count: number }>();
    const gone = new Map<string, Set<string>>();
    for (const m of todo) {
      const h = holderOf(m.id);
      if (h && h.id !== target.id) {
        gone.set(h.id, (gone.get(h.id) ?? new Set()).add(m.id));
        const e = moved.get(h.id) ?? { itemId: h.id, streamId: h.streamId, title: h.title, count: 0 };
        e.count++;
        moved.set(h.id, e);
        if (!flat) {
          aliases.add(`${input.channel}:${m.id}`);
          if (h.data.slack?.threadTs === m.id) for (const a of [h.externalId, ...(h.data.mergedExternalIds ?? [])]) aliases.add(a);
        }
      }
    }
    const have = new Map((target.data.messages ?? []).map((m) => [m.id, m]));
    let added = 0;
    for (const m of todo) {
      if (!have.has(m.id)) added++;
      have.set(m.id, m);
    }
    aliases.delete(target.externalId);
    const data: ItemData = {
      ...target.data,
      messages: [...have.values()].sort((a, b) => a.at.localeCompare(b.at)),
      mergedExternalIds: aliases.size ? [...aliases] : undefined,
    };
    await this.db.updateTable('items').set({ data: j(data), updated_at: t }).where('id', '=', target.id).execute();
    const affected = new Set<string>();
    if (input.toStreamId) affected.add(input.toStreamId);
    for (const [holderId, ids] of gone) {
      const h = family.find((i) => i.id === holderId)!;
      const left = (h.data.messages ?? []).filter((m) => !ids.has(m.id));
      if (h.streamId) affected.add(h.streamId);
      if (left.length) {
        const hd: ItemData = { ...h.data, messages: left };
        await this.db.updateTable('items').set({ data: j(hd) }).where('id', '=', h.id).execute();
        bus.publish({ type: 'item.updated', item: { ...h, data: hd } });
      } else {
        await this.db.updateTable('inbound_events').set({ item_id: target.id }).where('item_id', '=', h.id).execute();
        await this.db.deleteFrom('message_html').where('item_id', '=', h.id).execute();
        await this.db.deleteFrom('items').where('id', '=', h.id).execute();
        bus.publish({ type: 'item.updated', item: { ...h, streamId: null } }); // takes its tab away
      }
    }
    const item = (await this.getItem(target.id))!;
    bus.publish({ type: 'item.updated', item });
    for (const id of affected) await this.emitStream(id);
    return { item, added, created, moved: [...moved.values()] };
  }

  /**
   * One-time cleanup of DM items an earlier version split per message: fold them into the first one
   * (only within the same work stream, or when at most one is in a stream).
   */
  async mergeSlackDmItems() {
    const rows = await this.db.selectFrom('items').selectAll().where('source', '=', 'slack').orderBy('updated_at', 'asc').execute();
    const byChannel = new Map<string, ItemRow[]>();
    for (const r of rows) {
      const c = Repo.slackDmChannel('slack', r.external_id);
      if (c) byChannel.set(c, [...(byChannel.get(c) ?? []), r]);
    }
    let merged = 0;
    for (const group of byChannel.values()) {
      if (group.length < 2) continue;
      // A conversation split across work streams has one item per stream on purpose; only duplicates inside one stream are folded.
      const streams = new Set(group.map((r) => r.stream_id));
      if (streams.size > 1 || !group[0].stream_id) continue;
      const keep = group[0];
      const kept = this.toItem(keep);
      const messages = new Map((kept.data.messages ?? []).map((m) => [m.id, m]));
      for (const r of group) {
        if (r.id === keep.id) continue;
        for (const m of this.toItem(r).data.messages ?? []) messages.set(m.id, m);
        await this.db.updateTable('inbound_events').set({ item_id: keep.id }).where('item_id', '=', r.id).execute();
        await this.db.deleteFrom('message_html').where('item_id', '=', r.id).execute();
        await this.db.deleteFrom('items').where('id', '=', r.id).execute();
        merged++;
      }
      const data: ItemData = { ...kept.data, messages: [...messages.values()].sort((a, b) => a.at.localeCompare(b.at)) };
      await this.db.updateTable('items').set({ data: j(data) }).where('id', '=', keep.id).execute();
      const item = await this.getItem(keep.id);
      if (item) bus.publish({ type: 'item.updated', item });
      if (keep.stream_id) await this.emitStream(keep.stream_id);
    }
    return merged;
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
    // Email HTML is kept apart from the item (which Claude reads and the UI lists); only the text stays in item data.
    const htmls = (input.data.messages ?? []).filter((m) => m.html).map((m) => ({ id: m.id, html: m.html! }));
    if (htmls.length) input = { ...input, data: { ...input.data, messages: input.data.messages!.map(({ html: _h, ...m }) => m) } };
    const res = await this.upsertItemInner(input);
    for (const h of htmls) await this.saveMessageHtml(res.item.id, h.id, h.html);
    return res;
  }

  async saveMessageHtml(itemId: string, messageId: string, html: string) {
    await this.db
      .insertInto('message_html')
      .values({ item_id: itemId, message_id: messageId, html })
      .onConflict((oc) => oc.columns(['item_id', 'message_id']).doUpdateSet({ html }))
      .execute();
  }

  /** Original HTML by message id for an item's emails. */
  async getMessageHtml(itemId: string): Promise<Record<string, string>> {
    const rows = await this.db.selectFrom('message_html').select(['message_id', 'html']).where('item_id', '=', itemId).execute();
    return Object.fromEntries(rows.map((r) => [r.message_id, r.html]));
  }

  private async upsertItemInner(input: Omit<StreamItem, 'id' | 'updatedAt' | 'streamId'> & { streamId?: string | null }) {
    // A Slack DM is one conversation: later messages go into its existing item instead of starting a new "thread" per message.
    const dm = await this.findSlackDmItem(input.source, input.externalId);
    if (dm) input = { ...input, externalId: dm.externalId, title: /^Slack (DM|message)\b/.test(dm.title) && input.title ? input.title : dm.title };
    let existing = await this.findItem(input.source, input.externalId);
    if (!existing && input.source === 'slack') {
      // A message that was folded into another item arrives again: it belongs to that item.
      const alias = await this.findAliasItem(input.externalId);
      if (alias) {
        input = { ...input, externalId: alias.externalId, title: alias.title };
        existing = alias;
      }
    }
    // A conversation can be split across work streams: a message another item of the same conversation already holds stays there.
    let holder: StreamItem | undefined;
    if (input.source === 'slack' && input.data.messages?.length) {
      const channel = input.data.slack?.channel ?? /^([A-Z][A-Z0-9]{6,})(?::|$)/.exec(input.externalId)?.[1];
      if (channel) {
        const claimed = new Map<string, StreamItem>();
        for (const it of await this.slackFamily(channel)) if (it.id !== existing?.id) for (const m of it.data.messages ?? []) claimed.set(m.id, it);
        const mine = input.data.messages.filter((m) => !claimed.has(m.id));
        if (mine.length !== input.data.messages.length) {
          holder = claimed.get(input.data.messages.find((m) => claimed.has(m.id))!.id);
          input = { ...input, data: { ...input.data, messages: mine } };
          if (!mine.length && !existing) return { item: holder!, newMessages: [] as ThreadMessage[], created: false, changed: false, ticketMeta: undefined };
        }
      }
    }
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
      return { item, newMessages: input.data.messages ?? [], created: true, changed: true, ticketMeta: undefined };
    }
    const prev = existing.data;
    const incoming = input.data.messages ?? [];
    // A locally recorded copy of something the PU sent ("sent-…") gives way to the real message once it arrives.
    // (Slack sends carry a "Sent using Work Commander" footer that the local copy lacks.)
    const norm = (t: string) => t.replace(/\s+/g, ' ').replace(/\s*\*?Sent using\*? Work Commander\s*$/i, '').trim();
    const same = (a: string, b: string) => norm(a) === norm(b);
    const echoes = new Set<string>(); // real messages that are just WC's own sends coming back
    if (prev.messages?.some((m) => m.id.startsWith('sent-'))) {
      const copies = prev.messages.filter((m) => m.id.startsWith('sent-'));
      for (const x of incoming) if (x.isFromPU && copies.some((m) => same(x.text, m.text))) echoes.add(x.id);
      prev.messages = prev.messages.filter((m) => !(m.id.startsWith('sent-') && incoming.some((x) => x.isFromPU && same(x.text, m.text))));
    }
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
    const ticketMeta = ticketChanged && prev.ticket && input.data.ticket ? { status: [prev.ticket.status, input.data.ticket.status] as [string, string], assignee: [prev.ticket.assignee, input.data.ticket.assignee] as [string | undefined, string | undefined] } : undefined;
    const fresh = newMessages.filter((m) => !echoes.has(m.id));
    return { item, newMessages: fresh, created: false, changed: fresh.length > 0 || ticketChanged, ticketMeta };
  }

  /**
   * Add a message the PU just sent through an MCP server to the stream's matching conversation item.
   * MCP servers give no reliable way to re-fetch the thread, so this records it until the next poll brings the real copy.
   */
  async recordSentMessage(streamId: string, source: 'slack', match: { channel: string; threadTs?: string }, text: string, id: string, pu: { name?: string; email?: string }) {
    const items = (await this.listItems(streamId)).filter((i) => i.source === source && (i.data.slack?.channel ?? i.externalId.split(':')[0]) === match.channel);
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

  /**
   * Something the PU sent or created through an MCP server: add it to the stream's matching item, or create the item there.
   * An item that already lives in another work stream is left where it is.
   */
  async recordSentOrCreate(
    streamId: string,
    source: 'slack' | 'gmail' | 'jira' | 'jsm',
    match: { channel?: string; threadTs?: string; threadId?: string; ticketKey?: string },
    msg: ThreadMessage | null,
    create: { kind: StreamItem['kind']; externalId: string; title: string; url?: string; data: ItemData },
  ) {
    const inStream = await this.listItems(streamId);
    if (match.ticketKey && inStream.some((i) => i.data.ticket?.key === match.ticketKey)) return null;
    if (source === 'slack' && match.channel && msg) {
      const r = await this.recordSentMessage(streamId, 'slack', { channel: match.channel, threadTs: match.threadTs }, msg.text, msg.id.replace(/^sent-/, ''), { name: msg.author.name, email: msg.author.email });
      if (r) return r;
    }
    if (source === 'gmail' && match.threadId && msg) {
      const it = inStream.find((i) => i.source === 'gmail' && i.externalId === match.threadId);
      if (it) {
        const t = now();
        const data: ItemData = { ...it.data, messages: [...(it.data.messages ?? []), msg] };
        await this.db.updateTable('items').set({ data: j(data), updated_at: t }).where('id', '=', it.id).execute();
        const item = { ...it, data, updatedAt: t };
        bus.publish({ type: 'item.updated', item });
        return item;
      }
    }
    const data: ItemData = { ...create.data, ...(msg ? { messages: [msg] } : {}) };
    const { item } = await this.upsertItem({ source, kind: create.kind, externalId: create.externalId, title: create.title, url: create.url, data, streamId });
    if (!item.streamId) await this.attachItem(item.id, streamId);
    return (await this.getItem(item.id)) ?? item;
  }

  async attachItem(itemId: string, streamId: string) {
    const cur = await this.getItem(itemId);
    const set: { stream_id: string; updated_at: string; data?: string } = { stream_id: streamId, updated_at: now() };
    // Deliberately (re)attaching an item to a stream overrides an earlier "not relevant" for that stream.
    if (cur?.data.notRelevantTo?.includes(streamId)) {
      const notRelevantTo = cur.data.notRelevantTo.filter((x) => x !== streamId);
      set.data = j({ ...cur.data, notRelevantTo: notRelevantTo.length ? notRelevantTo : undefined });
    }
    await this.db.updateTable('items').set(set).where('id', '=', itemId).execute();
    const item = await this.getItem(itemId);
    if (item) bus.publish({ type: 'item.updated', item });
    if (item?.source === 'slack') await this.mergeSiblingChannelItems(streamId);
  }

  /** The single open work stream that already mentions `needle` (a ticket key) in its title, summary or items; null if none or several. */
  async findOpenStreamMentioning(needle: string, excluded: string[] = []) {
    const n = needle.toLowerCase();
    const like = `%${needle}%`;
    const rows = await this.db.selectFrom('items').select('stream_id').where('stream_id', 'is not', null).where((eb) => eb.or([eb('title', 'like', like), eb('data', 'like', like)])).execute();
    const ids = new Set(rows.map((r) => r.stream_id as string));
    const open = (await this.listStreams(false)).filter((s) => !excluded.includes(s.id) && (ids.has(s.id) || `${s.title} ${s.summary}`.toLowerCase().includes(n)));
    return open.length === 1 ? open[0] : null;
  }

  /** Move an item into another open work stream (from a stream, or from the skipped list). */
  async moveItem(itemId: string, toStreamId: string) {
    const it = await this.getItem(itemId);
    if (!it) throw new Error('Item not found');
    const to = await this.getStream(toStreamId);
    if (!to) throw new Error('Work stream not found');
    if (to.status !== 'open') throw new Error('Reopen that work stream before moving items into it');
    if (it.streamId === toStreamId) return;
    const from = it.streamId ? await this.getStream(it.streamId) : null;
    await this.attachItem(itemId, toStreamId);
    await this.audit('pu', 'item.moved', { itemId, from: it.streamId, to: toStreamId });
    await this.addChat({ streamId: toStreamId, role: 'system', content: `"${it.title}" moved here${from ? ` from "${from.title}"` : ''}.` });
    await this.updateStream(toStreamId, { touch: true });
    if (from) {
      await this.addChat({ streamId: from.id, role: 'system', content: `"${it.title}" moved to "${to.title}".` });
      await this.emitStream(from.id);
    }
  }

  /**
   * The PU says this item isn't relevant to the work stream. It leaves the stream (it shows up under "Skipped",
   * where it can be triaged again) and triage won't attach it to this stream again.
   */
  async markItemNotRelevant(itemId: string, streamId: string) {
    const it = await this.getItem(itemId);
    if (!it || it.streamId !== streamId) throw new Error('That item is not in this work stream');
    const data: ItemData = { ...it.data, notRelevantTo: [...new Set([...(it.data.notRelevantTo ?? []), streamId])] };
    await this.db.updateTable('items').set({ stream_id: null, data: j(data), updated_at: now() }).where('id', '=', itemId).execute();
    await this.audit('pu', 'item.not_relevant', { itemId, streamId });
    await this.addChat({ streamId, role: 'system', content: `"${it.title}" marked not relevant to this work stream and removed from it.` });
    bus.publish({ type: 'item.updated', item: { ...it, data, streamId: null } });
    await this.emitStream(streamId);
  }

  /**
   * The PU turned down Claude's suggested next step. If nothing else is waiting on them in the stream,
   * offer to close it (a normal close proposal the PU still approves). Returns the proposal, or null if not offered.
   */
  async offerCloseAfterDecline(streamId: string | null, suggestionId: string) {
    if (!streamId) return null;
    const stream = await this.getStream(streamId);
    if (!stream || stream.status !== 'open') return null;
    if ((await this.listProposals({ streamId, status: ['pending'] })).length) return null; // drafts or a close already waiting
    if ((await this.listChat(streamId)).some((m) => m.role === 'suggestion' && (m.meta.suggestion?.status ?? 'open') === 'open')) return null; // another next step still open
    const p = await this.createProposal({
      streamId,
      runId: `declined-${suggestionId}`,
      kind: 'stream_close',
      system: 'internal',
      title: 'Close this work stream',
      rationale: 'You turned down the suggested next step and nothing else is pending here.',
      payload: { reason: 'The suggested next step was declined and nothing else is pending.' },
      editable: [{ key: 'reason', label: 'Reason', type: 'readonly' }],
    });
    await this.addChat({ streamId, role: 'system', content: 'You passed on that next step, so I\'ve offered to close this work stream. Approve the close in the drafts pane, or leave it open.' });
    return p;
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
    /** A draft the PU started themselves: it doesn't count as Claude starting more work (so it leaves a pending close suggestion alone). */
    quick?: boolean;
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
    if (p.streamId && p.kind !== 'stream_close' && !input.quick) await this.withdrawStaleClose(p.streamId, 'Claude started more work on this stream', p.runId);
    // A new draft to the same place from a later turn replaces the older unsent one (e.g. "change that reply").
    const target = draftTarget(p);
    // Drafts the PU started themselves (Quick Reply) never replace Claude's, and Claude's never replace theirs.
    if (target && !input.quick) {
      const older = (await this.listProposals({ streamId: p.streamId, status: ['pending'] })).filter((x) => x.id !== p.id && x.runId !== p.runId && draftTarget(x) === target && !(x.payload as any).quick);
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

  /** Pending drafts aimed at the conversation an item represents (same Slack channel / email thread). */
  async pendingDraftsForItem(streamId: string, item: StreamItem) {
    const channel = item.data.slack?.channel ?? (item.source === 'slack' ? item.externalId.split(':')[0] : undefined);
    const thread = item.data.gmail?.threadId ?? (item.source === 'gmail' ? item.externalId : undefined);
    return (await this.listProposals({ streamId, status: ['pending'] })).filter((p) => {
      const x = p.payload as any;
      const a = x.args ?? {};
      return (!!channel && [x.channel, a.channel_id, a.channel].includes(channel)) || (!!thread && [x.thread_id, a.thread_id, a.threadId].includes(thread));
    });
  }

  /** Mark open questions to the PU as answered-elsewhere (they replied on their own). */
  async supersedeQuestions(streamId: string) {
    let n = 0;
    for (const m of await this.listChat(streamId)) {
      if (m.role === 'question' && !m.meta.question?.answered) {
        await this.updateChatMeta(m.id, { ...m.meta, question: { ...m.meta.question, answered: true } });
        n++;
      }
    }
    return n;
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
  /** WC just changed this ticket's status (e.g. resolved it): remember, so the resulting state isn't treated as new activity. */
  async noteWcTransition(itemId: string) {
    const it = await this.getItem(itemId);
    if (it) await this.db.updateTable('items').set({ data: j({ ...it.data, wcTransitionAt: now() }) }).where('id', '=', itemId).execute();
  }

  /**
   * Find earlier work streams that look like a query (keywords against titles, summaries, item titles and what Claude said or did in
   * their chat). Plain keyword scoring, so it is explainable; `matched` is how many distinct words hit.
   */
  async searchPastWork(query: string, opts: { excludeStreamId?: string | null; closedOnly?: boolean; limit?: number; minMatched?: number } = {}) {
    const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'was', 'are', 'you', 'your', 'can', 'could', 'please', 'will', 'would', 'about', 'there', 'their', 'what', 'when', 'which', 'into', 'just', 'need', 'hello', 'thanks', 'thank', 'regards']);
    const tokens = [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])].filter((t) => !STOP.has(t)).slice(0, 14);
    if (!tokens.length) return [];
    let q = this.db.selectFrom('streams').selectAll().orderBy('last_activity_at', 'desc').limit(500);
    if (opts.closedOnly) q = q.where('status', '=', 'closed');
    const streams = (await q.execute()).filter((s) => s.id !== opts.excludeStreamId);
    if (!streams.length) return [];
    const hits = new Map<string, { score: number; matched: Set<string>; snippet?: string; best: number }>();
    const hit = (id: string) => hits.get(id) ?? hits.set(id, { score: 0, matched: new Set(), best: 0 }).get(id)!;
    for (const s of streams) {
      const title = s.title.toLowerCase();
      const summary = s.summary.toLowerCase();
      for (const t of tokens) {
        const w = (title.includes(t) ? 3 : 0) + (summary.includes(t) ? 2 : 0);
        if (w) Object.assign(hit(s.id), { score: hit(s.id).score + w }), hit(s.id).matched.add(t);
      }
    }
    const ids = new Set(streams.map((s) => s.id));
    const like = (col: any) => (eb: any) => eb.or(tokens.map((t) => eb(col, 'like', `%${t}%`)));
    const items = await this.db.selectFrom('items').select(['stream_id', 'title']).where('stream_id', 'is not', null).where(like('title')).limit(400).execute();
    for (const it of items) {
      if (!it.stream_id || !ids.has(it.stream_id)) continue;
      const title = it.title.toLowerCase();
      for (const t of tokens) if (title.includes(t)) Object.assign(hit(it.stream_id), { score: hit(it.stream_id).score + 2 }), hit(it.stream_id).matched.add(t);
    }
    const chat = await this.db.selectFrom('chat_messages').select(['stream_id', 'content', 'role']).where('role', 'in', ['assistant', 'system']).where(like('content')).orderBy('created_at', 'desc').limit(400).execute();
    for (const m of chat) {
      if (!m.stream_id || !ids.has(m.stream_id)) continue;
      const text = m.content.toLowerCase();
      const found = tokens.filter((t) => text.includes(t));
      const h = hit(m.stream_id);
      for (const t of found) {
        if (!h.matched.has(t)) h.score += 1;
        h.matched.add(t);
      }
      if (found.length > h.best) Object.assign(h, { best: found.length, snippet: m.content.replace(/\s+/g, ' ').slice(0, 260) });
    }
    const byId = new Map(streams.map((s) => [s.id, s]));
    return [...hits]
      .filter(([, h]) => h.matched.size >= (opts.minMatched ?? 1))
      .sort((a, b) => b[1].matched.size - a[1].matched.size || b[1].score - a[1].score)
      .slice(0, opts.limit ?? 5)
      .map(([id, h]) => {
        const s = byId.get(id)!;
        return { id, title: s.title, status: s.status, closedAt: s.closed_at ?? undefined, summary: s.summary.slice(0, 400), snippet: h.snippet, matched: h.matched.size, score: h.score };
      });
  }

  /** Hide a skipped item from the Skipped list until it has new activity. */
  async dismissSkipped(itemId: string) {
    const it = await this.getItem(itemId);
    if (!it || it.streamId) throw new Error('Not a skipped item');
    await this.db.updateTable('items').set({ data: j({ ...it.data, dismissedAt: now() }) }).where('id', '=', itemId).execute();
    await this.audit('pu', 'item.skipped_dismissed', { itemId });
  }

  /** Recent items triage passed over (in no stream), with the reason from their latest triage decision. */
  async listSkipped(days = 14, includeDismissed = false) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = await this.db.selectFrom('items').selectAll().where('stream_id', 'is', null).where('updated_at', '>=', since).orderBy('updated_at', 'desc').limit(50).execute();
    const out = [];
    for (const r of rows) {
      const ev = await this.db.selectFrom('inbound_events').select(['decision', 'processed_at']).where('item_id', '=', r.id).where('processed_at', 'is not', null).orderBy('processed_at', 'desc').limit(1).executeTakeFirst();
      const d = pj<{ reason?: string; skipped?: string }>(ev?.decision, {});
      const it = this.toItem(r);
      const dismissed = !!it.data.dismissedAt && it.updatedAt <= it.data.dismissedAt;
      if (dismissed && !includeDismissed) continue;
      const last = (it.data.messages ?? it.data.ticket?.comments ?? []).slice(-1)[0];
      out.push({ id: it.id, source: it.source, title: it.title, updatedAt: it.updatedAt, from: last?.author.name ?? last?.author.email ?? '', reason: it.data.notRelevantTo?.length ? 'You marked it not relevant to a work stream' : (d.reason ?? d.skipped ?? ''), dismissed });
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
  /** Events that were recorded but never judged (e.g. the server stopped mid-triage). Recent ones only. */
  async listUnprocessedInbound(olderThanMs: number, limit = 10) {
    const before = new Date(Date.now() - olderThanMs).toISOString();
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
    return this.db.selectFrom('inbound_events').select(['source', 'external_id', 'item_id']).where('processed_at', 'is', null).where('received_at', '<=', before).where('received_at', '>', since).orderBy('received_at', 'asc').limit(limit).execute();
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
