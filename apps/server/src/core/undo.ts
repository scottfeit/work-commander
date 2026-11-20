import type { GmailAction, ItemData, UndoInfo } from '@wc/shared';
import type { DB } from '../db/index.js';
import type { Repo } from './repo.js';
import { bus } from './bus.js';

/**
 * System-wide Undo for the PU's own actions (never Claude's or triage's). Each action is captured as what it changed:
 * the fields of the items and work streams it touched, streams it created or removed, drafts it created or moved,
 * suggestion states, and the Laya training examples it wrote. Undo puts those back. The last three are kept, on the server.
 */

type StreamRow = DB['streams'];
type ItemRow = DB['items'];
const KEY = 'undo.stack';
const KEEP = 3;
/** Item data that is content (arrives from outside), not state the PU sets: undo never rewinds it, except for a Slack message move. */
const CONTENT_KEYS = new Set(['messages', 'ticket', 'body', 'raw', 'slack', 'gmail']);

export type { GmailAction };
export const GMAIL_INVERSE: Record<GmailAction, GmailAction> = { read: 'unread', unread: 'read', archive: 'unarchive', unarchive: 'archive', trash: 'untrash', untrash: 'trash' };

interface ItemChange {
  id: string;
  /** Present when the item's stream changed. */
  streamId?: string | null;
  /** Data keys to put back (null = the key was absent). */
  data: Record<string, unknown>;
  /** Slack message moves: the whole data, messages included. */
  full?: ItemData;
  /** An item a Slack move merged away: put back whole. */
  row?: ItemRow;
}
interface Entry {
  id: string;
  label: string;
  at: string;
  items: ItemChange[];
  /** Items the action created (removed on undo). */
  createdItems: string[];
  streams: { id: string; before: Partial<StreamRow> }[];
  /** Streams the action removed: put back whole, with their chat, overview history and hand-offs. */
  deletedStreams: { row: StreamRow; chat: DB['chat_messages'][]; summaries: Omit<DB['stream_summaries'], 'id'>[]; handoffs: DB['handoffs'][] }[];
  createdStreams: string[];
  /** Overview versions the action wrote (removed on undo). */
  newSummaryIds: number[];
  /** Pending drafts the action moved to another stream. */
  proposalMoves: { id: string; streamId: string | null }[];
  /** Pending drafts the action made (e.g. the close offer after passing on a suggestion). */
  newProposals: string[];
  /** Accepting into an existing stream: drafts Claude makes afterwards for this item go too. */
  draftsFor?: { itemId: string; streamId: string };
  chats: { id: string; meta: string }[];
  laya: { itemIds: string[]; examples: DB['laya_examples'][]; compare: { id: number; claude: string; agree: number | null; corrected: number }[] };
  gmail?: { itemId: string; undo: GmailAction; toInbox?: boolean };
  /** A Jira status change from the item's own control: undo moves it back. */
  jira?: { itemId: string; status: string };
  /** A Slack message move can be undone only while no new message arrives in that conversation. */
  slack?: { channel: string; messageIds: string[] };
}

export interface CaptureTarget {
  items?: (string | null | undefined)[];
  streams?: (string | null | undefined)[];
  chats?: string[];
  /** All items of this Slack conversation, whole (a message move). */
  slackChannel?: string;
}

export interface UndoDeps {
  repo: Repo;
  /** Applies a Gmail action to an item's thread (and refreshes its stored state). */
  gmail: (itemId: string, action: GmailAction, opts: { toInbox?: boolean }) => Promise<unknown>;
  /** Moves a ticket back to a status. */
  jiraStatus?: (itemId: string, status: string) => Promise<unknown>;
  /** Laya re-checks its parts after training examples change. */
  layaChanged?: () => Promise<void>;
}

const uniq = <T>(xs: (T | null | undefined)[]) => [...new Set(xs.filter((x): x is T => x !== null && x !== undefined))];
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export class UndoLog {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private deps: UndoDeps) {}
  private get db() {
    return this.deps.repo.db;
  }
  /** One undo-log operation at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async load(): Promise<Entry[]> {
    try {
      return JSON.parse((await this.deps.repo.getSync(KEY)) ?? '[]');
    } catch {
      return [];
    }
  }
  private async save(stack: Entry[]) {
    await this.deps.repo.setSync(KEY, JSON.stringify(stack.slice(-KEEP)));
    bus.publish({ type: 'undo.changed', undo: await this.infoOf(stack.slice(-KEEP)) });
  }

  /** What Undo would do next (and how many steps are kept). Drops Slack moves that new messages have made stale. */
  async info(): Promise<UndoInfo> {
    return this.serial(async () => {
      const stack = await this.load();
      const kept = await this.prune(stack);
      if (kept.length !== stack.length) await this.deps.repo.setSync(KEY, JSON.stringify(kept));
      return this.infoOf(kept);
    });
  }
  private async infoOf(stack: Entry[]): Promise<UndoInfo> {
    const top = stack[stack.length - 1];
    return { next: top ? top.label : null, count: stack.length };
  }
  private async prune(stack: Entry[]) {
    const out: Entry[] = [];
    for (const e of stack) if (await this.stillUndoable(e)) out.push(e);
    return out;
  }
  private async stillUndoable(e: Entry) {
    if (!e.slack) return true;
    const now = (await this.deps.repo.slackFamily(e.slack.channel)).flatMap((i) => (i.data.messages ?? []).map((m) => m.id));
    return same([...now].sort(), [...e.slack.messageIds].sort());
  }

  /**
   * Run one of the PU's actions and remember how to undo it. `fn` returns the work streams and items it created
   * (when it knows them), so undo can remove them.
   */
  async capture<T>(label: string | ((r: T) => string), target: CaptureTarget, fn: () => Promise<T>, opts: { created?: (r: T) => { streams?: (string | null | undefined)[]; items?: (string | null | undefined)[] }; draftsFor?: (r: T) => Entry['draftsFor'] } = {}): Promise<T> {
    const at = new Date().toISOString();
    const before = await this.snapshot(target, !!target.items?.length || !!target.slackChannel);
    const result = await fn();
    try {
      const created = opts.created?.(result) ?? {};
      // Only streams that are new since the action began (accepting can also file into an existing one).
      const hinted = uniq(created.streams ?? []).filter((id) => !before.streams.has(id));
      const createdStreams = hinted.length ? (await this.db.selectFrom('streams').select(['id', 'created_at']).where('id', 'in', hinted).execute()).filter((r) => r.created_at >= at).map((r) => r.id) : [];
      const after = await this.snapshot({ ...target, streams: [...(target.streams ?? []), ...createdStreams] });
      const entry = this.diff(typeof label === 'function' ? label(result) : label, at, before, after, createdStreams, uniq(created.items ?? []));
      entry.draftsFor = opts.draftsFor?.(result);
      if (this.isEmpty(entry)) return result;
      await this.serial(async () => this.save([...(await this.prune(await this.load())), entry]));
    } catch (e: any) {
      console.error('[undo] could not record', label, e.message); // the action itself went through
    }
    return result;
  }

  /** A Gmail button: undo applies the opposite action. */
  async recordGmail(label: string, itemId: string, action: GmailAction, wasInInbox: boolean) {
    const e = this.blank(label, new Date().toISOString());
    e.gmail = { itemId, undo: GMAIL_INVERSE[action], toInbox: action === 'trash' && wasInInbox };
    await this.serial(async () => this.save([...(await this.prune(await this.load())), e]));
  }

  /** A Jira status change: undo moves the ticket back to the status it had. */
  async recordJiraStatus(label: string, itemId: string, previous: string) {
    const e = this.blank(label, new Date().toISOString());
    e.jira = { itemId, status: previous };
    await this.serial(async () => this.save([...(await this.prune(await this.load())), e]));
  }

  /** Undo the most recent action still undoable. Returns what was undone, or null when there is nothing. */
  async undo(): Promise<string | null> {
    return this.serial(async () => {
      const stack = await this.prune(await this.load());
      const e = stack.pop();
      if (!e) {
        await this.save(stack);
        return null;
      }
      await this.apply(e);
      await this.deps.repo.audit('pu', 'undo', { label: e.label });
      await this.save(stack);
      return e.label;
    });
  }

  // ---------- capturing ----------

  private async snapshot(t: CaptureTarget, withExtras = false) {
    const db = this.db;
    let itemIds = uniq(t.items ?? []);
    if (t.slackChannel) itemIds = uniq([...itemIds, ...(await this.deps.repo.slackFamily(t.slackChannel)).map((i) => i.id)]);
    const items = new Map<string, ItemRow>();
    for (const r of itemIds.length ? await db.selectFrom('items').selectAll().where('id', 'in', itemIds).execute() : []) items.set(r.id, r);
    // The streams those items are in count as touched too (a move can empty and remove the one it came from).
    const streamIds = uniq([...(t.streams ?? []), ...[...items.values()].map((r) => r.stream_id)]);
    const streams = new Map<string, StreamRow>();
    for (const r of streamIds.length ? await db.selectFrom('streams').selectAll().where('id', 'in', streamIds).execute() : []) streams.set(r.id, r);
    const proposals = streamIds.length ? await db.selectFrom('proposals').select(['id', 'stream_id']).where('stream_id', 'in', streamIds).where('status', '=', 'pending').execute() : [];
    const summaryMax = streamIds.length ? await db.selectFrom('stream_summaries').select(['stream_id', db.fn.max('id').as('m')]).where('stream_id', 'in', streamIds).groupBy('stream_id').execute() : [];
    const chats = new Map<string, string>();
    for (const r of t.chats?.length ? await db.selectFrom('chat_messages').select(['id', 'meta']).where('id', 'in', t.chats).execute() : []) chats.set(r.id, r.meta);
    const laya = itemIds.length ? await db.selectFrom('laya_examples').selectAll().where('item_id', 'in', itemIds).execute() : [];
    const compare = itemIds.length ? await db.selectFrom('laya_compare').select(['id', 'claude', 'agree', 'corrected']).where('item_id', 'in', itemIds).execute() : [];
    // A move can empty and remove a stream: keep what's needed to put it back (only taken before the action).
    const extras = new Map<string, Omit<Entry['deletedStreams'][number], 'row'>>();
    if (withExtras)
      for (const id of streams.keys())
        extras.set(id, {
          chat: await db.selectFrom('chat_messages').selectAll().where('stream_id', '=', id).execute(),
          summaries: (await db.selectFrom('stream_summaries').selectAll().where('stream_id', '=', id).orderBy('id', 'asc').execute()).map(({ id: _i, ...r }) => r),
          handoffs: await db.selectFrom('handoffs').selectAll().where('stream_id', '=', id).execute(),
        });
    return { extras, itemIds, items, streams, streamIds, proposals, summaryMax: new Map(summaryMax.map((r) => [r.stream_id, Number(r.m ?? 0)])), chats, laya, compare, slackChannel: t.slackChannel };
  }

  private blank(label: string, at: string): Entry {
    return { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, label, at, items: [], createdItems: [], streams: [], deletedStreams: [], createdStreams: [], newSummaryIds: [], proposalMoves: [], newProposals: [], chats: [], laya: { itemIds: [], examples: [], compare: [] } };
  }
  private isEmpty(e: Entry) {
    return !e.items.length && !e.createdItems.length && !e.streams.length && !e.deletedStreams.length && !e.createdStreams.length && !e.proposalMoves.length && !e.newProposals.length && !e.chats.length && !e.laya.itemIds.length && !e.gmail && !e.jira;
  }

  private diff(label: string, at: string, b: Awaited<ReturnType<UndoLog['snapshot']>>, a: Awaited<ReturnType<UndoLog['snapshot']>>, createdStreams: string[], createdItemsHint: string[]): Entry {
    const e = this.blank(label, at);
    const full = !!b.slackChannel;
    for (const [id, was] of b.items) {
      const now = a.items.get(id);
      if (!now) continue; // removed by the action: nothing the PU's actions do, except merging Slack items (restored whole below)
      const ch: ItemChange = { id, data: {} };
      if (was.stream_id !== now.stream_id) ch.streamId = was.stream_id;
      if (full) {
        if (was.data !== now.data) ch.full = JSON.parse(was.data);
      } else {
        const d0 = JSON.parse(was.data) as Record<string, unknown>;
        const d1 = JSON.parse(now.data) as Record<string, unknown>;
        for (const k of new Set([...Object.keys(d0), ...Object.keys(d1)])) if (!CONTENT_KEYS.has(k) && !same(d0[k], d1[k])) ch.data[k] = d0[k] ?? null;
      }
      if (ch.streamId !== undefined || ch.full || Object.keys(ch.data).length) e.items.push(ch);
    }
    // Slack moves can merge a moved item into another one of the same conversation: put back any that went.
    if (full) for (const [id, was] of b.items) if (!a.items.has(id)) e.items.push({ id, streamId: was.stream_id, data: {}, full: JSON.parse(was.data), row: was });
    e.createdItems = uniq([...createdItemsHint, ...(full ? [...a.items.keys()].filter((id) => !b.items.has(id)) : [])]);
    if (full) e.slack = { channel: b.slackChannel!, messageIds: [...a.items.values()].flatMap((r) => ((JSON.parse(r.data) as ItemData).messages ?? []).map((m) => m.id)) };

    for (const [id, was] of b.streams) {
      const now = a.streams.get(id);
      if (!now) {
        const x = b.extras.get(id);
        if (x) e.deletedStreams.push({ row: was, ...x });
        continue;
      }
      const before: Partial<StreamRow> = {};
      for (const k of Object.keys(was) as (keyof StreamRow)[]) if (k !== 'updated_at' && k !== 'agent_session_id' && was[k] !== now[k]) (before as any)[k] = was[k];
      if (Object.keys(before).length) e.streams.push({ id, before });
    }
    e.createdStreams = createdStreams;
    for (const p of b.proposals) {
      const now = a.proposals.find((x) => x.id === p.id);
      if (now && now.stream_id !== p.stream_id) e.proposalMoves.push({ id: p.id, streamId: p.stream_id });
    }
    e.newProposals = a.proposals.filter((p) => !b.proposals.some((x) => x.id === p.id) && !createdStreams.includes(p.stream_id ?? '')).map((p) => p.id);
    for (const [sid, m] of a.summaryMax) if (!createdStreams.includes(sid) && m > (b.summaryMax.get(sid) ?? 0)) e.newSummaryIds.push(m);
    for (const [id, meta] of b.chats) if (a.chats.get(id) !== meta) e.chats.push({ id, meta });
    const layaChanged = !same(b.laya.map((r) => [r.id, r.gold, r.source, r.state]), a.laya.map((r) => [r.id, r.gold, r.source, r.state])) || !same(b.compare, a.compare);
    if (layaChanged) e.laya = { itemIds: b.itemIds, examples: b.laya, compare: b.compare };
    return e;
  }

  // ---------- undoing ----------

  private async apply(e: Entry) {
    const { repo } = this.deps;
    const db = this.db;
    if (e.gmail) {
      await this.deps.gmail(e.gmail.itemId, e.gmail.undo, { toInbox: e.gmail.toInbox });
      return;
    }
    if (e.jira) {
      if (!this.deps.jiraStatus) throw new Error('Jira is not connected');
      await this.deps.jiraStatus(e.jira.itemId, e.jira.status);
      return;
    }
    // 1. Streams the action removed come back first, so items and drafts have somewhere to return to.
    for (const d of e.deletedStreams) {
      if (await db.selectFrom('streams').select('id').where('id', '=', d.row.id).executeTakeFirst()) continue;
      await db.insertInto('streams').values(d.row).execute();
      for (const c of d.chat) await db.insertInto('chat_messages').values(c).onConflict((oc) => oc.column('id').doNothing()).execute();
      for (const s of d.summaries) await db.insertInto('stream_summaries').values(s).execute();
      for (const h of d.handoffs) await db.insertInto('handoffs').values(h).onConflict((oc) => oc.column('id').doNothing()).execute();
    }
    // 2. Items: their stream, and the state the PU set on them.
    const touchedStreams = new Set<string>();
    for (const ch of e.items) {
      let cur = await repo.getItem(ch.id);
      if (!cur && ch.row) {
        await db.insertInto('items').values(ch.row).execute(); // merged away by a Slack move
        cur = await repo.getItem(ch.id);
      }
      if (!cur) continue;
      const data: Record<string, unknown> = ch.full ? { ...ch.full } : { ...cur.data };
      if (!ch.full) for (const [k, v] of Object.entries(ch.data)) v === null ? delete data[k] : (data[k] = v);
      const streamId = ch.streamId !== undefined ? ch.streamId : cur.streamId;
      await db.updateTable('items').set({ data: JSON.stringify(data), stream_id: streamId }).where('id', '=', ch.id).execute();
      for (const s of [cur.streamId, streamId]) if (s) touchedStreams.add(s);
      bus.publish({ type: 'item.updated', item: { ...cur, streamId, data: data as ItemData } });
    }
    for (const id of e.createdItems) {
      const cur = await repo.getItem(id);
      if (!cur) continue;
      await db.deleteFrom('message_html').where('item_id', '=', id).execute();
      await db.deleteFrom('items').where('id', '=', id).execute();
      bus.publish({ type: 'item.updated', item: { ...cur, streamId: '__removed__' } });
      if (cur.streamId) touchedStreams.add(cur.streamId);
    }
    // 3. Streams: the fields the action changed.
    for (const s of e.streams) {
      if (!(await db.selectFrom('streams').select('id').where('id', '=', s.id).executeTakeFirst())) continue;
      await db.updateTable('streams').set({ ...s.before, updated_at: new Date().toISOString() }).where('id', '=', s.id).execute();
      touchedStreams.add(s.id);
    }
    if (e.newSummaryIds.length) await db.deleteFrom('stream_summaries').where('id', 'in', e.newSummaryIds).execute();
    // 4. Drafts: moved ones go back; ones the action made are withdrawn.
    for (const m of e.proposalMoves) {
      const p = await repo.getProposal(m.id);
      if (!p || p.status !== 'pending') continue;
      await db.updateTable('proposals').set({ stream_id: m.streamId }).where('id', '=', m.id).execute();
      bus.publish({ type: 'proposal.updated', proposal: { ...p, streamId: m.streamId } });
    }
    if (e.newProposals.length) await repo.withdrawProposals(e.newProposals, 'you undid the action that made it');
    if (e.draftsFor) {
      const item = await repo.getItem(e.draftsFor.itemId);
      const at = e.at;
      if (item) await repo.withdrawProposals((await repo.pendingDraftsForItem(e.draftsFor.streamId, item)).filter((p) => p.createdAt >= at).map((p) => p.id), 'you undid accepting the item it was for');
    }
    // 5. Suggestions the PU accepted or passed on.
    for (const c of e.chats) {
      const m = await repo.getChat(c.id);
      if (m) await repo.updateChatMeta(c.id, JSON.parse(c.meta));
    }
    // 6. Streams the action created go, with everything in them.
    const home = e.items.find((c) => c.streamId)?.streamId ?? null;
    for (const id of e.createdStreams) await this.removeStream(id, home);
    // 7. Laya forgets what the action taught it.
    if (e.laya.itemIds.length) {
      await db.deleteFrom('laya_examples').where('item_id', 'in', e.laya.itemIds).execute();
      for (const r of e.laya.examples) await db.insertInto('laya_examples').values(r).execute();
      for (const c of e.laya.compare) await db.updateTable('laya_compare').set({ claude: c.claude, agree: c.agree, corrected: c.corrected }).where('id', '=', c.id).execute();
      await this.deps.layaChanged?.().catch(() => undefined);
    }
    for (const d of e.deletedStreams) touchedStreams.add(d.row.id);
    for (const id of touchedStreams) await repo.emitStream(id);
  }

  private async removeStream(id: string, movedTo: string | null) {
    const db = this.db;
    if (!(await db.selectFrom('streams').select('id').where('id', '=', id).executeTakeFirst())) return;
    const items = await db.selectFrom('items').select('id').where('stream_id', '=', id).execute();
    if (items.length) await db.updateTable('items').set({ stream_id: null }).where('stream_id', '=', id).execute();
    for (const p of await this.deps.repo.listProposals({ streamId: id, status: ['pending'] })) {
      await db.updateTable('proposals').set({ status: 'withdrawn', error: 'you undid the action that made its work stream' }).where('id', '=', p.id).execute();
      bus.publish({ type: 'proposal.updated', proposal: { ...p, status: 'withdrawn' } });
    }
    await db.deleteFrom('chat_messages').where('stream_id', '=', id).execute();
    await db.deleteFrom('stream_summaries').where('stream_id', '=', id).execute();
    await db.deleteFrom('streams').where('id', '=', id).execute();
    bus.publish({ type: 'stream.deleted', streamId: id, movedTo });
  }
}
