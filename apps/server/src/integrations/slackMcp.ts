import type { ThreadMessage } from '@wc/shared';
import type { InboundItem } from './types.js';

/**
 * Reading Slack through its MCP server without Claude. Slack's hosted server returns fixed text layouts, so the reads that
 * ingestion needs (channel/DM history, a thread, a search) are plain tool calls parsed here, instead of a Claude session
 * that makes the same calls and copies the results out again.
 */

export type McpCall = (tool: string, args: Record<string, unknown>) => Promise<string>;

const iso = (ts: string) => new Date(Number(ts) * 1000).toISOString();
/** Slack puts zero-width spaces into display names ("scott.​feit"). */
const clean = (s: string) => s.replace(/[​-‍﻿]/g, '').trim();

function body(text: string, key: 'messages' | 'results' | 'result') {
  try {
    const j = JSON.parse(text);
    for (const k of [key, 'messages', 'results', 'result']) if (typeof j?.[k] === 'string') return { body: j[k] as string, more: /more (?:messages|results)|next page/i.test(String(j.pagination_info ?? '')), cursor: /cursor `([^`]+)`/.exec(String(j.pagination_info ?? ''))?.[1] };
  } catch {
    /* plain text */
  }
  return { body: text, more: false, cursor: undefined };
}

// One message header, in either layout Slack uses:
//   "=== Message from Name <email> (U123[, external: …]) at 2026-11-10 22:22:41 PST ==="
//   "From: Name <email> (U123[, external: …])\nTime: …"
// each followed by "Message TS: 1794378161.277929".
const HEADER =
  /(?:^|\n)(?:=== \w+ from\s*([^\n<(]+?)(?:\s*<([^>\n]+)>)?(?:\s*\(([A-Z0-9]+)(?:,[^)\n]*)?\))?\s+at [^\n]*?===[^\n]*|From:\s*([^\n<(]*?)(?:\s*<([^>\n]+)>)?(?:\s*\(([A-Z0-9]+)(?:,[^)\n]*)?\))?[^\S\n]*(?:\nTime:[^\n]*)?)\nMessage TS:\s*([\d.]+)[^\n]*/g;

export interface ParsedSlackMessage extends ThreadMessage {
  /** "Thread: 3 replies (latest: …)" under a channel-history message. */
  replies?: number;
  /** When the newest of those replies was posted (unix seconds); undefined when the time can't be read. */
  repliesLatest?: number;
}

const TZ_OFFSETS: Record<string, string> = { PST: '-08:00', PDT: '-07:00', MST: '-07:00', MDT: '-06:00', CST: '-06:00', CDT: '-05:00', EST: '-05:00', EDT: '-04:00', UTC: 'Z', GMT: 'Z', BST: '+01:00', CET: '+01:00', CEST: '+02:00', EET: '+02:00', EEST: '+03:00' };

/** "2026-11-17 12:48:06 PST" -> unix seconds. Common US and European zone names are known; anything else is undefined. */
export function parseSlackClock(s: string): number | undefined {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ?([A-Z]{2,5})?$/.exec(s.trim());
  if (!m) return undefined;
  const off = TZ_OFFSETS[m[3] ?? 'UTC'];
  if (!off) return undefined;
  const t = Date.parse(`${m[1]}T${m[2]}${off}`);
  return Number.isNaN(t) ? undefined : t / 1000;
}

/** Parse Slack MCP read output (slack_read_channel / slack_read_thread) into messages, oldest first. */
export function parseSlackMessages(text: string, me: { userId?: string; email?: string }): { messages: ParsedSlackMessage[]; channelLabel?: string; more: boolean } {
  const { body: b, more } = body(text, 'messages');
  const channelLabel = /^Channel:\s*(.+?)\s*\(([A-Z0-9]+)\)/m.exec(b)?.[1];
  const heads = [...b.matchAll(HEADER)];
  const messages: ParsedSlackMessage[] = [];
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index! : b.length;
    let t = b.slice(h.index! + h[0].length, end);
    const rep = /\nThread: (\d+) repl(?:y|ies)(?: \(latest: ([^)\n]*)\))?[^\n]*/.exec(`\n${t}`);
    const replies = rep?.[1];
    const repliesLatest = rep?.[2] ? parseSlackClock(rep[2]) : undefined;
    t = t
      .replace(/\n(?:=== [^\n]*===|No thread messs?ages|Thread: \d+ repl(?:y|ies)[^\n]*)\s*(?=\n|$)/gi, '\n')
      .replace(/^\s*\n/, '')
      .trim();
    const name = clean(h[1] ?? h[4] ?? '');
    const email = (h[2] ?? h[5])?.trim().toLowerCase();
    const uid = h[3] ?? h[6];
    const ts = h[7];
    messages.push({
      id: ts,
      author: { name: name || undefined, email, slackUserId: uid },
      text: t,
      at: iso(ts),
      isFromPU: (!!me.userId && uid === me.userId) || (!!me.email && !!email && email === me.email.toLowerCase()),
      ...(replies ? { replies: Number(replies), ...(repliesLatest !== undefined ? { repliesLatest } : {}) } : {}),
    });
  });
  return { messages: messages.sort((a, c) => a.at.localeCompare(c.at)), channelLabel, more };
}

export interface SlackSearchHit {
  channel: string;
  channelLabel: string;
  ts: string;
  /** The thread the hit is in, when its permalink says so. */
  threadTs?: string;
  url?: string;
  fromUserId?: string;
  /** Everyone in a group DM (its "Participants:" line). */
  participants?: { name: string; id: string }[];
}

const participants = (block: string) => {
  const line = /^Participants:\s*(.+)$/m.exec(block)?.[1];
  if (!line) return undefined;
  return [...line.matchAll(/\s*([^,(]+?)\s*\(ID:\s*([A-Z0-9]+)\)/g)].map((m) => ({ name: m[1].trim(), id: m[2] }));
};

/** Parse slack_search_public_and_private output. */
export function parseSlackSearch(text: string): { hits: SlackSearchHit[]; cursor?: string } {
  const { body: b, cursor } = body(text, 'results');
  const hits: SlackSearchHit[] = [];
  for (const block of b.split(/\n(?=### Result )/).slice(1)) {
    const ch = /^Channel:\s*(.*?)\s*\(ID:\s*([A-Z0-9]+)\)/m.exec(block);
    const ts = /^Message_ts:\s*([\d.]+)/m.exec(block)?.[1];
    if (!ch || !ts) continue;
    const url = /^Permalink:.*?\((https?:[^)\s]+)\)/m.exec(block)?.[1]?.replace(/\\\//g, '/');
    hits.push({
      channel: ch[2],
      channelLabel: clean(ch[1]),
      ts,
      threadTs: url ? /[?&]thread_ts=([\d.]+)/.exec(url)?.[1] : undefined,
      url,
      fromUserId: /^From:.*?\(ID:\s*([A-Z0-9]+)\)/m.exec(block)?.[1],
      participants: participants(block),
    });
  }
  return { hits, cursor };
}

const isDm = (channel: string, label = '') => channel.startsWith('D') || /^(?:Group )?DM\b|^mpdm-/i.test(label);
const labelOf = (channel: string, label?: string) => (isDm(channel, label) ? (label && !/^DM$/i.test(label) ? label : 'Slack DM') : label ? (label.startsWith('#') ? label : `#${label}`) : `Slack ${channel}`);

export interface DirectPollInput {
  /** Unix seconds: messages after this are new. */
  since: number;
  puEmail: string;
  /** The PU's Slack user id, when known (Slack's MCP server states it in its tool descriptions). */
  me?: string;
  watched: string[];
  /** DM / group DM conversations already in open work streams, read from the newest message held. */
  conversations: { channel: string; after: string }[];
  /** Threads in open work streams, re-read whole. */
  threads: { channel: string; ts: string }[];
}

/**
 * One poll, the way Slack API mode polls: mentions of the PU and DM/group DM activity via search, watched channels via history,
 * and the conversations already in work streams read directly. Returns items in the shape ingestion takes.
 */
/** How far before the last check a DM's history is read, to find older threads with new replies. */
const THREAD_LOOKBACK_S = 7 * 86_400;
const MAX_DM_THREADS = 10;
/** Most thread reads in one poll across all conversations (Slack's MCP server rate-limits). */
const MAX_THREAD_READS = 15;

export async function pollSlackDirect(call: McpCall, p: DirectPollInput): Promise<{ items: InboundItem[]; reads: number }> {
  const me = { userId: p.me, email: p.puEmail };
  const items = new Map<string, InboundItem>();
  let reads = 0;
  let threadReads = 0;
  const run = async (tool: string, args: Record<string, unknown>) => {
    reads++;
    return call(tool, args);
  };
  const date = (unix: number) => new Date(unix * 1000 - 86_400_000).toISOString().slice(0, 10); // search dates are day-granular: start a day early
  const search = async (args: Record<string, unknown>, pages = 2) => {
    const out: SlackSearchHit[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < pages; i++) {
      const r = parseSlackSearch(await run('slack_search_public_and_private', { ...args, after: String(Math.floor(p.since)), sort: 'timestamp', limit: 20, include_context: false, response_format: 'detailed', natural_language_query: '', ...(cursor ? { cursor } : {}) }));
      out.push(...r.hits.filter((h) => Number(h.ts) > p.since));
      cursor = r.cursor;
      if (!cursor) break;
    }
    return out;
  };

  /**
   * A DM or group DM as one item: its messages after `after`, and the replies in its threads. Slack keeps thread replies out of channel
   * history (the parent only says "N replies, latest …"), so a recent thread with a newer reply is read separately and merged in.
   */
  const addDm = async (channel: string, after: number, label?: string, url?: string, threadTs?: string) => {
    if (items.has(`${channel}:dm`)) return;
    // Look back past `after` so a thread started earlier, with a reply since, is seen.
    const r = parseSlackMessages(await run('slack_read_channel', { channel_id: channel, oldest: String(after - THREAD_LOOKBACK_S), limit: 100, response_format: 'detailed' }), me);
    const found = new Map<string, ThreadMessage>();
    for (const { replies: _r, repliesLatest: _l, ...m } of r.messages) if (Number(m.id) > after) found.set(m.id, m);
    // A reply time that can't be read counts only for recent threads, so an unknown time zone can't mean re-reading every old thread.
    const parents = r.messages
      .filter((m) => m.replies && (m.repliesLatest !== undefined ? m.repliesLatest > after : Number(m.id) > after - 2 * 86_400))
      .map((m) => m.id)
      .reverse(); // newest threads first
    if (threadTs && !parents.includes(threadTs)) parents.unshift(threadTs);
    for (const ts of parents.slice(0, MAX_DM_THREADS)) {
      if (threadReads >= MAX_THREAD_READS) break;
      threadReads++;
      const t = parseSlackMessages(await run('slack_read_thread', { channel_id: channel, message_ts: ts, limit: 200, response_format: 'detailed' }), me);
      for (const { replies: _r, repliesLatest: _l, ...m } of t.messages) if (Number(m.id) > after && m.id !== ts) found.set(m.id, m);
    }
    const messages = [...found.values()].sort((a, c) => Number(a.id) - Number(c.id));
    if (!messages.length) return;
    const other = messages.find((m) => !m.isFromPU)?.author.name;
    const name = r.channelLabel && !/^DM$/i.test(r.channelLabel) ? r.channelLabel : other ? `DM with ${other}` : label && !/^DM$/i.test(label) ? label : 'Slack DM';
    items.set(`${channel}:dm`, {
      source: 'slack',
      kind: 'slack_thread',
      externalId: `${channel}:dm`,
      title: name,
      url,
      data: { messages, slack: { channel, channelName: name, threadTs: messages[0].id } },
      eventId: `${channel}:dm@${messages[messages.length - 1].id}`,
    });
  };
  const addThread = async (channel: string, ts: string, label?: string, url?: string) => {
    const r = parseSlackMessages(await run('slack_read_thread', { channel_id: channel, message_ts: ts, limit: 200, response_format: 'detailed' }), me);
    const messages = r.messages.map(({ replies: _r, ...m }) => m);
    if (!messages.length) return;
    const parent = messages[0].id;
    const externalId = `${channel}:${parent}`;
    if (items.has(externalId) || !messages.some((m) => Number(m.id) > p.since)) return;
    const name = labelOf(channel, r.channelLabel ?? label);
    items.set(externalId, {
      source: 'slack',
      kind: 'slack_thread',
      externalId,
      title: `${name}: ${messages[0].text.replace(/\s+/g, ' ').slice(0, 80)}`,
      url,
      data: { messages, slack: { channel, channelName: name, threadTs: parent } },
      eventId: `${externalId}@${messages[messages.length - 1].id}`,
    });
  };
  const fromHit = async (h: SlackSearchHit) => (isDm(h.channel, h.channelLabel) ? addDm(h.channel, p.since, h.channelLabel, h.url, h.threadTs) : addThread(h.channel, h.threadTs ?? h.ts, h.channelLabel, h.url));

  // 1. Mentions of the PU anywhere, and 2. anything in their DMs and group DMs (their own messages too).
  if (p.me) for (const h of await search({ keywords: [`<@${p.me}>`] })) await fromHit(h);
  for (const h of await search({ filters: `after:${date(p.since)}`, channel_types: 'im,mpim' }, 3)) await fromHit(h);

  // 3. Watched channels: every new top-level message and thread, even without a mention.
  for (const w of p.watched) {
    let id = /^[CG][A-Z0-9]{6,}$/.test(w) ? w : null;
    if (!id) {
      const found = await run('slack_search_channels', { keywords: [w.replace(/^#/, '')], limit: 10, response_format: 'concise' });
      const m = new RegExp(`#?${w.replace(/^#/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[\\s\\S]{0,200}?\\b([CG][A-Z0-9]{8,})\\b`, 'i').exec(body(found, 'result').body);
      id = m?.[1] ?? null;
    }
    if (!id) continue;
    const r = parseSlackMessages(await run('slack_read_channel', { channel_id: id, oldest: String(p.since), limit: 50, response_format: 'detailed' }), me);
    for (const m of r.messages) if (Number(m.id) > p.since && !m.isFromPU) await addThread(id, m.id, r.channelLabel);
    // Replies don't show in channel history: find threads with new replies by search.
    for (const h of await search({ filters: `in:<#${id}> after:${date(p.since)}` }, 1)) await fromHit(h);
  }

  // 4. Conversations already in work streams, read directly rather than trusting search.
  for (const c of p.conversations) await addDm(c.channel, Date.parse(c.after) / 1000);
  for (const t of p.threads) await addThread(t.channel, t.ts);
  return { items: [...items.values()], reads };
}

/** Slack's MCP server names the signed-in user in its tool descriptions ("Current logged in user's user_id is U…"). */
export function selfIdFromTools(tools: { description?: string }[]) {
  for (const t of tools) {
    const m = /user_id is\s+(U[A-Z0-9]{6,})/.exec(t.description ?? '');
    if (m) return m[1];
  }
  return undefined;
}
