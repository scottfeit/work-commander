import { slackMessageUrl } from './slackUrl.js';
import type { WebClient } from '@slack/web-api';
import { slackClient } from './slackClient.js';
import type { MessageAttachment, SlackSettings, ThreadMessage } from '@wc/shared';
import type { ChatApi, InboundItem, InboundSink, Ingestor } from './types.js';
import type { Repo } from '../core/repo.js';
import type { OutFile } from '../core/attachments.js';

/**
 * Slack via a *user* token (xoxp-) so approved messages post as the PU. Socket Mode (app-level
 * token, xapp-) delivers events subscribed "on behalf of users" for real-time ingestion.
 */
/** "#sys-eng, #helpsec-ops\nC012345" -> ["sys-eng", "helpsec-ops", "C012345"] */
export function parseWatchedChannels(s: string | undefined) {
  return [...new Set((s ?? '').split(/[,\n;]+/).map((x) => x.trim().replace(/^#/, '')).filter(Boolean))];
}

/** A Slack message's emoji reactions, and whether the PU is among those who reacted. */
export function reactionsOf(m: { reactions?: any[] }, me: string): { reactions?: { name: string; count: number; mine: boolean }[] } {
  const r = (m.reactions ?? []).filter((x) => x?.name).map((x) => ({ name: String(x.name), count: Number(x.count ?? x.users?.length ?? 1), mine: (x.users ?? []).includes(me) }));
  return r.length ? { reactions: r } : {};
}

/** A Slack message's files, as attachments (fetched through the server with the token). */
export function filesOf(m: { files?: any[] }): { attachments?: MessageAttachment[] } {
  const a = (m.files ?? [])
    .filter((f) => f && f.id && (f.url_private_download || f.url_private) && f.mode !== 'tombstone')
    .map((f) => ({ id: String(f.id), name: String(f.name ?? f.title ?? 'file'), mimeType: String(f.mimetype ?? 'application/octet-stream'), size: typeof f.size === 'number' ? f.size : undefined, ref: String(f.url_private_download ?? f.url_private) }));
  return a.length ? { attachments: a } : {};
}

export class SlackWorkspace implements ChatApi {
  web: WebClient;
  private uid?: string;
  private teamUrl?: string;
  private names = new Map<string, { name: string; email?: string }>();
  constructor(private token: string) {
    this.web = slackClient(token);
  }

  /** Add (or take back) the PU's emoji reaction on a message. Reacting twice, or removing one that isn't there, is fine. */
  async react(channel: string, ts: string, name: string, add: boolean) {
    try {
      if (add) await this.web.reactions.add({ channel, timestamp: ts, name });
      else await this.web.reactions.remove({ channel, timestamp: ts, name });
    } catch (e: any) {
      const code = e?.data?.error;
      if (code === 'already_reacted' || code === 'no_reaction') return;
      if (code === 'missing_scope') throw new Error('The Slack app needs the reactions:write user scope (update it from deploy/slack-app-manifest.yaml and reinstall)');
      if (code === 'invalid_name') throw new Error(`Slack doesn't know the emoji :${name}:`);
      throw e;
    }
  }

  private scopeError(e: any): never {
    if (e?.data?.error === 'missing_scope') {
      throw new Error('The Slack app needs the channels:write, groups:write, im:write and mpim:write user scopes to mark conversations read (update it from deploy/slack-app-manifest.yaml and reinstall)');
    }
    throw e;
  }

  /** Is anything in this conversation newer than where the PU's read marker is? */
  async readState(channel: string): Promise<{ unread: boolean }> {
    try {
      const [info, h] = await Promise.all([this.web.conversations.info({ channel }), this.web.conversations.history({ channel, limit: 1 })]);
      const lastRead = Number((info.channel as any)?.last_read ?? 0);
      const latest = Number(((h.messages ?? []) as any[])[0]?.ts ?? 0);
      return { unread: latest > lastRead };
    } catch (e) {
      this.scopeError(e);
    }
  }

  /**
   * Mark a whole conversation read (marker on its latest message) or unread (marker just before its latest message, as Slack's own
   * "Mark unread" does). Threads have no public read marker, so this is for DMs, group DMs and channels.
   */
  async markConversation(channel: string, read: boolean): Promise<{ unread: boolean }> {
    try {
      const h = await this.web.conversations.history({ channel, limit: 2 });
      const msgs = ((h.messages ?? []) as any[]).sort((a, b) => Number(b.ts) - Number(a.ts));
      if (!msgs.length) return { unread: false };
      const ts = read ? msgs[0].ts : (msgs[1]?.ts ?? (Number(msgs[0].ts) - 0.000001).toFixed(6));
      await this.web.conversations.mark({ channel, ts });
      return { unread: !read };
    } catch (e) {
      this.scopeError(e);
    }
  }

  /**
   * The current reactions on some messages of one conversation, in one call: the thread's replies, or (for a DM or channel
   * discussion) the stretch of history they span.
   */
  async reactionsFor(channel: string, threadTs: string | null, ts: string[]): Promise<Map<string, ThreadMessage['reactions']>> {
    const me = await this.selfUserId();
    const want = new Set(ts);
    const sorted = [...ts].sort((a, b) => Number(a) - Number(b));
    const r = threadTs
      ? await this.web.conversations.replies({ channel, ts: threadTs, limit: 200 })
      : await this.web.conversations.history({ channel, oldest: sorted[0], latest: sorted[sorted.length - 1], inclusive: true, limit: 200 });
    const out = new Map<string, ThreadMessage['reactions']>();
    for (const m of (r.messages ?? []) as any[]) if (want.has(m.ts)) out.set(m.ts, reactionsOf(m, me).reactions ?? []);
    // a discussion gathered from the channel (not one thread): read the rest from history, also in one call
    const missing = sorted.filter((t) => !out.has(t));
    if (threadTs && missing.length) {
      const h = await this.web.conversations.history({ channel, oldest: missing[0], latest: missing[missing.length - 1], inclusive: true, limit: 200 });
      for (const m of (h.messages ?? []) as any[]) if (want.has(m.ts) && !out.has(m.ts)) out.set(m.ts, reactionsOf(m, me).reactions ?? []);
    }
    return out;
  }

  /** The workspace's own emoji (name -> image URL; aliases resolved). Empty without the emoji:read scope. */
  async customEmoji(): Promise<Record<string, string>> {
    try {
      const r = await this.web.emoji.list({});
      const all = (r.emoji ?? {}) as Record<string, string>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(all)) {
        const target = v.startsWith('alias:') ? all[v.slice(6)] : v;
        if (target && /^https:/.test(target)) out[k] = target;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** A file's bytes (Slack's private file URLs need the token). */
  async download(url: string): Promise<Buffer> {
    if (!/^https:\/\/([a-z0-9-]+\.)*slack(-edge)?\.com\//i.test(url)) throw new Error('Not a Slack file');
    const r = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!r.ok) throw new Error(`Slack file: ${r.status}${r.status === 403 ? ' (the Slack app needs the files:read user scope)' : ''}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async selfUserId() {
    if (!this.uid) {
      const r = await this.web.auth.test();
      this.uid = r.user_id as string;
      this.teamUrl = r.url as string;
    }
    return this.uid;
  }

  async user(id: string) {
    if (!this.names.has(id)) {
      try {
        const r = await this.web.users.info({ user: id });
        this.names.set(id, { name: r.user?.real_name || r.user?.name || id, email: r.user?.profile?.email ?? undefined });
      } catch {
        this.names.set(id, { name: id });
      }
    }
    return this.names.get(id)!;
  }

  async channelName(channel: string) {
    try {
      const r = await this.web.conversations.info({ channel });
      const c = r.channel as any;
      if (c?.is_im) return `DM with ${(await this.user(c.user)).name}`;
      return c?.name ? `#${c.name}` : channel;
    } catch {
      return channel;
    }
  }

  /** Replace <@U123> mentions with names so the model sees readable text. */
  private async render(text: string) {
    const ids = [...new Set([...text.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]))];
    let out = text;
    for (const id of ids) out = out.replaceAll(`<@${id}>`, `@${(await this.user(id)).name}`);
    return out;
  }

  async getThread(channel: string, threadTs: string, triggerTs?: string): Promise<InboundItem> {
    const me = await this.selfUserId();
    const r = await this.web.conversations.replies({ channel, ts: threadTs, limit: 200 });
    const msgs = (r.messages ?? []) as any[];
    const messages: ThreadMessage[] = [];
    for (const m of msgs) {
      const u = m.user ? await this.user(m.user) : { name: m.username ?? 'bot' };
      messages.push({
        id: m.ts,
        author: { name: u.name, email: (u as any).email, slackUserId: m.user },
        text: await this.render(m.text ?? ''),
        ...filesOf(m), ...reactionsOf(m, me),
        at: new Date(Number(m.ts) * 1000).toISOString(),
        isFromPU: m.user === me,
      });
    }
    const chName = await this.channelName(channel);
    let url: string | undefined;
    try {
      url = (await this.web.chat.getPermalink({ channel, message_ts: threadTs })).permalink as string;
    } catch {
      /* ignore */
    }
    return {
      source: 'slack',
      kind: 'slack_thread',
      externalId: `${channel}:${threadTs}`,
      title: `${chName}: ${(messages[0]?.text ?? '').slice(0, 80)}`,
      url,
      data: { messages, slack: { channel, channelName: chName, threadTs } },
      eventId: `${channel}:${triggerTs ?? msgs[msgs.length - 1]?.ts ?? threadTs}`,
    };
  }

  /** Messages in a channel after `oldest` (oldest first), for following a conversation on from a link. */
  async messagesAfter(channel: string, oldest: string, limit = 100): Promise<{ messages: ThreadMessage[]; channelLabel?: string }> {
    const me = await this.selfUserId();
    const h = await this.web.conversations.history({ channel, oldest, limit });
    const msgs = ((h.messages ?? []) as any[]).filter((m) => Number(m.ts) > Number(oldest)).sort((a, b) => Number(a.ts) - Number(b.ts));
    const messages: ThreadMessage[] = [];
    for (const m of msgs) {
      const u = m.user ? await this.user(m.user) : { name: m.username ?? 'bot' };
      messages.push({ id: m.ts, author: { name: u.name, email: (u as any).email, slackUserId: m.user }, text: await this.render(m.text ?? ''), ...filesOf(m), ...reactionsOf(m, me), at: new Date(Number(m.ts) * 1000).toISOString(), isFromPU: m.user === me });
    }
    return { messages, channelLabel: await this.channelName(channel) };
  }

  /** A whole DM conversation as one item: recent history including the PU's own messages. */
  async getDmConversation(channel: string, triggerTs?: string, after?: number): Promise<InboundItem> {
    const me = await this.selfUserId();
    const h = await this.web.conversations.history({ channel, limit: 50 });
    // With `after` (the poll's starting point), only what is newer: a DM seen for the first time must not bring months of history with it.
    const newer = (m: any) => after === undefined || Number(m.ts) > after;
    const msgs = ((h.messages ?? []) as any[]).filter(newer).sort((a, b) => Number(a.ts) - Number(b.ts));
    const parents = ((h.messages ?? []) as any[]).sort((a, b) => Number(a.ts) - Number(b.ts));
    // Thread replies are not in channel history: read the recently active threads and fold their replies into the conversation.
    const recent = Date.now() / 1000 - 7 * 86_400;
    const threaded = parents.filter((m) => m.reply_count > 0 && Number(m.latest_reply ?? m.ts) > recent && (after === undefined || Number(m.latest_reply ?? m.ts) > after)).slice(-8);
    for (const parent of threaded) {
      const r = await this.web.conversations.replies({ channel, ts: parent.ts, limit: 100 });
      for (const m of (r.messages ?? []) as any[]) if (m.ts !== parent.ts && newer(m) && !msgs.some((x) => x.ts === m.ts)) msgs.push(m);
    }
    msgs.sort((a, b) => Number(a.ts) - Number(b.ts));
    const messages: ThreadMessage[] = [];
    for (const m of msgs) {
      const u = m.user ? await this.user(m.user) : { name: m.username ?? 'bot' };
      messages.push({ id: m.ts, author: { name: u.name, email: (u as any).email, slackUserId: m.user }, text: await this.render(m.text ?? ''), ...filesOf(m), ...reactionsOf(m, me), at: new Date(Number(m.ts) * 1000).toISOString(), isFromPU: m.user === me });
    }
    const chName = await this.channelName(channel);
    return {
      source: 'slack',
      kind: 'slack_thread',
      externalId: `${channel}:dm`,
      title: chName,
      url: this.teamUrl && msgs.length ? slackMessageUrl(this.teamUrl, channel, msgs[msgs.length - 1].ts) : undefined,
      data: { messages, slack: { channel, channelName: chName, threadTs: msgs[0]?.ts ?? '' } },
      eventId: `${channel}:${triggerTs ?? msgs[msgs.length - 1]?.ts ?? 'dm'}`,
    };
  }

  async search(query: string, max = 10, page = 1) {
    const r = await this.web.search.messages({ query, count: max, sort: 'timestamp', page });
    return ((r.messages as any)?.matches ?? []).map((m: any) => ({
      channel: m.channel?.id,
      ts: m.ts,
      threadTs: m.thread_ts,
      user: m.username ?? m.user,
      text: m.text,
      permalink: m.permalink,
    }));
  }

  async lookupUserByEmail(email: string) {
    try {
      const r = await this.web.users.lookupByEmail({ email });
      return r.user ? { id: r.user.id!, name: r.user.real_name || r.user.name || email } : null;
    } catch {
      return null;
    }
  }

  async postMessage(input: { channel?: string; userEmail?: string; userId?: string; text: string; threadTs?: string; files?: OutFile[] }) {
    let channel = input.channel;
    if (!channel) {
      const uid = input.userId ?? (input.userEmail ? (await this.lookupUserByEmail(input.userEmail))?.id : undefined);
      if (!uid) throw new Error(`No Slack user found for ${input.userEmail ?? input.userId}`);
      const dm = await this.web.conversations.open({ users: uid });
      channel = dm.channel!.id!;
    }
    const r = await this.web.chat.postMessage({ channel, text: input.text, thread_ts: input.threadTs });
    if (input.files?.length) {
      // Files go in the same thread as the message (a new thread under it when the message is top-level).
      try {
        await this.web.files.uploadV2({ channel_id: channel, thread_ts: input.threadTs ?? r.ts!, file_uploads: input.files.map((f) => ({ file: f.data, filename: f.filename })) } as any);
      } catch (e: any) {
        const scope = /missing_scope|not_allowed_token_type/.test(e?.data?.error ?? e?.message ?? '');
        throw new Error(`Message posted, but attaching files failed: ${scope ? 'the Slack app needs the files:write user scope (update it from deploy/slack-app-manifest.yaml and reinstall)' : e.message}`);
      }
    }
    let permalink: string | undefined;
    try {
      permalink = (await this.web.chat.getPermalink({ channel, message_ts: r.ts! })).permalink as string;
    } catch {
      /* ignore */
    }
    return { channel, ts: r.ts!, permalink };
  }
}

/** Decide whether a Slack message is addressed to / involves the PU at the connector level. */
export function slackMessageInvolvesPU(ev: { channel_type?: string; text?: string; user?: string; thread_ts?: string }, puId: string, trackedThreads: Set<string>, channel: string) {
  if (ev.user === puId) return trackedThreads.has(`${channel}:${ev.thread_ts ?? ''}`); // PU's own replies only update tracked threads
  if (ev.channel_type === 'im' || ev.channel_type === 'mpim') return true;
  if (ev.text?.includes(`<@${puId}>`)) return true;
  if (ev.thread_ts && trackedThreads.has(`${channel}:${ev.thread_ts}`)) return true;
  return false;
}

/** Slack's answer for a thread that does not exist (deleted, or the timestamp is not a thread's parent). */
const POLL_OVERLAP_S = 10 * 60;
const threadGone = (e: any) => e?.data?.error === 'thread_not_found' || /thread_not_found/.test(String(e?.message ?? ''));

export class SlackIngestor implements Ingestor {
  private socket?: any;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private lastNotFound = '';
  private watchedIds?: { key: string; at: number; ids: Map<string, string | null> };
  constructor(
    private slack: SlackWorkspace,
    private s: SlackSettings,
    private appToken: string | null,
    private repo: Repo,
    private trackedThreads: () => Promise<Set<string>>,
    private sink: InboundSink,
    private status: (ok: boolean, msg: string) => void,
  ) {}

  async start() {
    if (this.s.ingestion === 'off') return;
    const me = await this.slack.selfUserId();
    if (this.s.ingestion === 'realtime') {
      if (!this.appToken) throw new Error('Slack real-time needs an app-level token (xapp-) for Socket Mode');
      const { SocketModeClient } = await import('@slack/socket-mode');
      this.socket = new SocketModeClient({ appToken: this.appToken });
      this.socket.on('message', async ({ event, ack }: any) => {
        await ack();
        try {
          if (event.subtype && !['thread_broadcast', 'file_share'].includes(event.subtype)) return;
          const tracked = await this.trackedThreads();
          if (!slackMessageInvolvesPU(event, me, tracked, event.channel)) return;
          await this.sink(await this.slack.getThread(event.channel, event.thread_ts ?? event.ts, event.ts));
        } catch (e: any) {
          this.status(false, `Slack event: ${e.message}`);
        }
      });
      // Reactions added or removed in Slack itself: just update the stored message (no triage, no tokens).
      for (const type of ['reaction_added', 'reaction_removed'] as const) {
        this.socket.on(type, async ({ event, ack }: any) => {
          await ack();
          try {
            if (event?.item?.type !== 'message' || !event.item.channel || !event.item.ts || !event.reaction) return;
            await this.repo.applySlackReactions(event.item.channel, { ts: event.item.ts, name: event.reaction, added: type === 'reaction_added', byPU: event.user === me });
          } catch (e: any) {
            this.status(false, `Slack reaction event: ${e.message}`);
          }
        });
      }
      this.socket.on('disconnect', () => this.status(false, 'Slack Socket Mode disconnected; reconnecting'));
      await this.socket.start();
      this.status(true, 'Slack Socket Mode connected');
    } else {
      await this.pollOnce();
      this.timer = setInterval(() => void this.pollOnce(), Math.max(20, this.s.pollSeconds) * 1000);
    }
  }

  async stop() {
    clearInterval(this.timer);
    await this.socket?.disconnect?.();
  }

  /**
   * Polling: (1) mentions of the PU via search, (2) direct and group DMs, (3) replies in threads
   * attached to open streams.
   */
  /**
   * Channel ids for the watched names. Names are looked up among the channels the PU is in (a short list), and only the ones not found
   * there among every channel in the workspace (a long list that Slack does not order and that may be cut short). Kept for ten minutes.
   */
  private async resolveWatched(watched: string[]) {
    const key = watched.join('|');
    if (this.watchedIds && this.watchedIds.key === key && Date.now() - this.watchedIds.at < 10 * 60_000) return this.watchedIds.ids;
    const ids = new Map<string, string | null>();
    const byName = new Map<string, string>();
    for (const w of watched) if (/^[CG][A-Z0-9]{6,}$/.test(w)) ids.set(w, w);
    const need = () => watched.filter((w) => !ids.has(w));
    const lookup = (name: string) => byName.get(name.toLowerCase().replace(/^#/, ''));
    if (need().length) {
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const r = await this.slack.web.users.conversations({ types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor });
        for (const c of r.channels ?? []) if (c.name && c.id) byName.set(c.name.toLowerCase(), c.id);
        cursor = r.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
      for (const w of need()) {
        const id = lookup(w);
        if (id) ids.set(w, id);
      }
    }
    if (need().length) {
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await this.slack.web.conversations.list({ types: 'public_channel,private_channel', exclude_archived: true, limit: 1000, cursor });
        for (const c of r.channels ?? []) if (c.name && c.id && !byName.has(c.name.toLowerCase())) byName.set(c.name.toLowerCase(), c.id);
        cursor = r.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
    }
    for (const w of watched) if (!ids.has(w)) ids.set(w, lookup(w) ?? null);
    // A name that could not be found is looked for again on the next poll; only complete answers are kept.
    if (![...ids.values()].includes(null)) this.watchedIds = { key, at: Date.now(), ids };
    else this.watchedIds = undefined;
    return ids;
  }

  /**
   * Where a poll starts reading: the saved bookmark; else, when Slack was read through MCP until now, where that left off (so switching
   * to API mode does not re-read days of old messages); else three days back (a first run).
   */
  private async startingPoint() {
    // The bookmark is when the last complete poll began; each poll starts a little before it, because search lags a little behind Slack.
    const saved = await this.repo.getSync('slack.lastTs');
    if (saved) return Number(saved) - POLL_OVERLAP_S;
    const mcp = Date.parse((await this.repo.getSync('mcp.slack.since')) ?? '');
    if (!Number.isNaN(mcp)) return mcp / 1000 - POLL_OVERLAP_S;
    return Date.now() / 1000 - 3 * 86400;
  }

  /** Every message in a conversation after `oldest`, all pages (newest first, as Slack returns them). */
  private async history(channel: string, oldest: string) {
    const out: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const h = await this.slack.web.conversations.history({ channel, oldest, limit: 200, cursor });
      out.push(...((h.messages ?? []) as any[]));
      cursor = h.has_more ? h.response_metadata?.next_cursor || undefined : undefined;
      if (!cursor) break;
    }
    return out;
  }

  /** Every reply in a thread after `oldest`, all pages (oldest first). */
  private async replies(channel: string, ts: string, oldest: string) {
    const out: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.slack.web.conversations.replies({ channel, ts, oldest, limit: 200, cursor });
      out.push(...((r.messages ?? []) as any[]));
      cursor = r.has_more ? r.response_metadata?.next_cursor || undefined : undefined;
      if (!cursor) break;
    }
    return out;
  }

  async pollOnce() {
    if (this.busy) return;
    this.busy = true;
    try {
      const me = await this.slack.selfUserId();
      const startedAt = Date.now() / 1000;
      const since = await this.startingPoint();
      const seen = new Set<string>();
      const unreadable: string[] = []; // threads Slack says do not exist (deleted, or not a thread): skipped, never a reason to stop polling
      const emit = async (channel: string, threadTs: string, ts: string) => {
        const k = `${channel}:${threadTs}`;
        if (seen.has(k)) return;
        seen.add(k);
        try {
          await this.sink(await this.slack.getThread(channel, threadTs, ts));
        } catch (e: any) {
          if (!threadGone(e)) throw e;
          unreadable.push(k);
        }
      };
      // Mentions: newest first, page by page until they're older than the bookmark (so a long gap loses none).
      for (let page = 1; page <= 20; page++) {
        const hits = await this.slack.search(`<@${me}>`, 100, page);
        for (const m of hits) if (Number(m.ts) > since && m.channel) await emit(m.channel, m.threadTs ?? m.ts, m.ts);
        if (hits.length < 100 || Number(hits[hits.length - 1]?.ts) <= since) break;
      }
      // Direct and group DMs: found by searching for recent DM messages (the list of conversations has no order and is long), then each one's
      // history is read. If search is unavailable, fall back to walking the conversation list.
      const dms = new Set<string>();
      try {
        for (let page = 1; page <= 5; page++) {
          const hits = await this.slack.search(`is:dm after:${new Date((since - 86_400) * 1000).toISOString().slice(0, 10)}`, 100, page);
          for (const h of hits) if (h.channel && Number(h.ts) > since) dms.add(h.channel);
          if (hits.length < 100 || Number(hits[hits.length - 1]?.ts) <= since) break;
        }
      } catch (e: any) {
        console.warn(`[slack] DM search failed, walking the conversation list instead: ${e.message}`);
        let cursor: string | undefined;
        for (let page = 0; page < 5; page++) {
          const r = await this.slack.web.conversations.list({ types: 'im,mpim', exclude_archived: true, limit: 200, cursor });
          for (const c of r.channels ?? []) if (c.id) dms.add(c.id);
          cursor = r.response_metadata?.next_cursor || undefined;
          if (!cursor) break;
        }
      }
      for (const id of dms) {
        // Look back a week: a thread started earlier may have a new reply, which history shows only on its parent (reply_count, latest_reply).
        const all = await this.history(id, String(since - 7 * 86_400));
        const activity = (m: any) => Math.max(Number(m.ts), Number(m.latest_reply ?? 0));
        const msgs = all.filter((m) => activity(m) > since);
        if (id.startsWith('D')) {
          // A DM is one conversation item; new messages from either side (the PU's own replies too) update it.
          if (msgs.length && !seen.has(id)) {
            seen.add(id);
            const newest = msgs.reduce((a, b) => (activity(b) > activity(a) ? b : a));
            await this.sink(await this.slack.getDmConversation(id, String(activity(newest)), since));
          }
        } else for (const m of msgs) if (m.user !== me || Number(m.latest_reply ?? 0) > since) await emit(id, m.thread_ts ?? m.ts, String(activity(m)));
      }
      // Watched channels: new messages there, even when they don't mention the PU.
      const watched = parseWatchedChannels(this.s.watchedChannels);
      const notFound: string[] = [];
      const readFrom: string[] = [];
      const label = (w: string) => (/^[CG][A-Z0-9]{6,}$/.test(w) ? w : `#${w}`);
      if (watched.length) {
        const ids = await this.resolveWatched(watched);
        for (const w of watched) {
          const id = ids.get(w);
          if (!id) {
            notFound.push(label(w));
            continue;
          }
          const msgs = await this.history(id, String(since));
          if (msgs.length) readFrom.push(`${label(w)} ${msgs.length}`);
          for (const m of msgs) if (m.user !== me) await emit(id, m.thread_ts ?? m.ts, m.ts);
        }
      }
      if (readFrom.length) console.log(`[slack] watched channels with messages since the last check: ${readFrom.join(', ')}`);
      const missing = notFound.join(', ');
      if (missing !== this.lastNotFound) {
        this.lastNotFound = missing;
        if (missing) console.warn(`[slack] could not find these watched channels, so they are not being read: ${missing}`);
      }
      for (const k of await this.trackedThreads()) {
        const [channel, threadTs] = k.split(':');
        // A DM or group DM item is a whole conversation ("<channel>:dm", or "<channel>:dm@<stream>" when split), not a thread: the DM reads above cover it.
        if (!/^\d+\.\d+$/.test(threadTs ?? '')) continue;
        try {
          const fresh = (await this.replies(channel, threadTs, String(since))).filter((m) => Number(m.ts) > since);
          if (fresh.length) await emit(channel, threadTs, fresh[fresh.length - 1].ts);
        } catch (e: any) {
          if (!threadGone(e)) throw e; // a rate limit or a network error: stop here and look again next time, bookmark unmoved
          unreadable.push(k);
        }
      }
      await this.repo.setSync('slack.lastTs', String(startedAt));
      if (unreadable.length) console.warn(`[slack] skipped ${unreadable.length} thread(s) Slack could not read (thread_not_found): ${[...new Set(unreadable)].join(', ')}`);
      const uniq = [...new Set(unreadable)];
      const notes = [
        ...(uniq.length ? [`skipped ${uniq.length} thread(s) Slack could not read: ${uniq.slice(0, 3).join(', ')}${uniq.length > 3 ? ', …' : ''}`] : []),
        ...(notFound.length ? [`could not find watched channel(s): ${notFound.join(', ')}`] : []),
      ];
      this.status(true, notes.length ? `Slack synced (${notes.join('; ')})` : 'Slack synced');
    } catch (e: any) {
      this.status(false, `Slack: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }
}
