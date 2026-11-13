import type { Settings, StreamItem, ThreadMessage } from '@wc/shared';
import { Repo } from './repo.js';
import type { IntegrationHub } from '../integrations/hub.js';
import type { InboundItem } from '../integrations/types.js';
import { McpConnection } from '../integrations/mcp.js';
import { attachDriveFile } from './docs.js';

export type ParsedLink =
  | { kind: 'slack'; channel: string; ts: string; threadTs?: string }
  | { kind: 'gmail'; threadId: string }
  | { kind: 'doc'; id: string; url: string }
  | { kind: 'jira'; key: string };

const UNSUPPORTED = 'Paste a link to a Slack message, a Gmail message, a Google Doc, Sheet or Slides file, or a Jira issue.';
const slackTs = (digits: string) => `${digits.slice(0, -6)}.${digits.slice(-6)}`;

/** Work out what a pasted link points at. Throws a plain-language error when it can't be used. */
export function parseWorkItemUrl(raw: string): ParsedLink {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(UNSUPPORTED);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(UNSUPPORTED);
  const host = u.hostname.toLowerCase();

  if (host === 'slack.com' || host.endsWith('.slack.com')) {
    const m = /^\/archives\/([A-Z][A-Z0-9]{6,})\/p(\d{11,})/.exec(u.pathname);
    if (!m) throw new Error('That Slack link is not a message link. Use "Copy link" on a message.');
    const threadTs = u.searchParams.get('thread_ts') ?? undefined;
    return { kind: 'slack', channel: m[1], ts: slackTs(m[2]), threadTs };
  }

  if (host === 'docs.google.com' || host === 'drive.google.com') {
    const m = /\/(?:document|spreadsheets|presentation|file)\/d\/([A-Za-z0-9_-]{10,})/.exec(u.pathname);
    const id = m?.[1] ?? u.searchParams.get('id');
    if (!id) throw new Error(UNSUPPORTED);
    return { kind: 'doc', id, url: u.hostname === 'docs.google.com' ? `https://docs.google.com${u.pathname.replace(/\/(edit|view|preview|htmlview).*$/, '')}/edit` : u.toString() };
  }

  if (host === 'mail.google.com') {
    // Only ids the Gmail API understands can be used: the hex thread id (?th=…, #inbox/<hex>) or a "thread-f:<number>" form.
    const hash = decodeURIComponent(u.hash);
    const cand = [u.searchParams.get('th'), u.searchParams.get('permthid'), u.searchParams.get('permmsgid'), hash.split('/').pop()?.split('?')[0]].filter(Boolean) as string[];
    for (const c of cand) {
      if (/^[0-9a-f]{15,16}$/i.test(c)) return { kind: 'gmail', threadId: c.toLowerCase() };
      const dec = /^(?:thread|msg)-[a-z]:(\d{10,})$/i.exec(c)?.[1];
      if (dec) return { kind: 'gmail', threadId: BigInt(dec).toString(16) };
    }
    throw new Error(
      "Gmail's normal address-bar links use an encoded id that Work Commander can't look up. Use a link that contains the thread id (…?th=… or …#inbox/<16 hex characters>), or ask Claude in the chat to find the message.",
    );
  }

  if (host.endsWith('.atlassian.net')) {
    const hay = `${u.pathname} ${u.searchParams.get('selectedIssue') ?? ''} ${u.hash}`;
    const key = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/.exec(hay)?.[1];
    if (!key) throw new Error("That Atlassian link doesn't point at a Jira issue.");
    return { kind: 'jira', key };
  }
  throw new Error(UNSUPPORTED);
}

const iso = (ts: string) => new Date(Number(ts) * 1000).toISOString();

/** Parse the Slack MCP server's `slack_read_thread` text ("=== THREAD PARENT MESSAGE ===\nFrom: Name <email> (UID)\nTime: …\nMessage TS: …\ntext"). */
export function parseSlackThreadText(text: string, puEmail: string): { messages: ThreadMessage[]; channelLabel?: string } {
  let body = text;
  try {
    const j = JSON.parse(text);
    if (typeof j?.messages === 'string') body = j.messages;
    else if (typeof j?.result === 'string') body = j.result;
  } catch {
    /* plain text */
  }
  const channelLabel = /^Channel:\s*(.+?)\s*\(([A-Z0-9]+)\)/m.exec(body)?.[1];
  const messages: ThreadMessage[] = [];
  for (const block of body.split(/\n(?==== )/)) {
    // Two layouts: "From: Name <email> (UID)\nTime: …\nMessage TS: …" and "=== Message from Name <email> (UID) at … ===\nMessage TS: …".
    const m =
      /From:\s*(.+?)(?:\s*<([^>]+)>)?(?:\s*\(([A-Z0-9]+)\))?\s*\n(?:Time:[^\n]*\n)?Message TS:\s*([\d.]+)\n([\s\S]*?)\s*$/.exec(block) ??
      /=== Message from\s*(.+?)(?:\s*<([^>]+)>)?(?:\s*\(([A-Z0-9]+)\))?\s+at [^=\n]*===\s*\nMessage TS:\s*([\d.]+)\n([\s\S]*?)\s*$/.exec(block);
    if (!m) continue;
    const text2 = m[5].replace(/\n+No thread messs?ages\s*$/i, '').replace(/\n+Thread: \d+ repl(?:y|ies)[^\n]*\s*$/i, '').replace(/^\s*\n/, '').trim();
    messages.push({
      id: m[4],
      author: { name: m[1].trim(), email: m[2]?.toLowerCase(), slackUserId: m[3] },
      text: text2,
      at: iso(m[4]),
      isFromPU: !!m[2] && m[2].toLowerCase() === puEmail.toLowerCase(),
    });
  }
  return { messages: messages.sort((a, b) => a.at.localeCompare(b.at)), channelLabel };
}

type Deps = { repo: Repo; hub: IntegrationHub; settings: () => Promise<Settings>; secret: (id: string) => Promise<string> };

async function fetchInbound(link: Exclude<ParsedLink, { kind: 'doc' }>, d: Deps): Promise<InboundItem> {
  const s = await d.settings();
  if (link.kind === 'jira') {
    if (s.atlassian.mode !== 'api') throw new Error("Adding a Jira issue by link needs the Atlassian API token connection (not MCP).");
    return (await d.hub.api('tickets')).getIssue(link.key);
  }
  if (link.kind === 'gmail') {
    if (s.google.mode !== 'oauth') throw new Error('Adding a Gmail message by link needs the Google sign-in connection (not MCP).');
    return (await d.hub.api('email')).getThread(link.threadId);
  }
  const parent = link.threadTs ?? link.ts;
  if (s.slack.mode === 'api') return (await d.hub.api('chat')).getThread(link.channel, parent);
  if (!s.slack.mcp) throw new Error('Slack is not connected');
  const conn = await McpConnection.open(s.slack.mcp, d.secret);
  try {
    const r = await conn.call('slack_read_thread', { channel_id: link.channel, message_ts: parent, response_format: 'detailed' });
    const { messages, channelLabel } = parseSlackThreadText(r.text, s.pu.email);
    if (!messages.length) throw new Error("Couldn't read that Slack message (are you in that channel?)");
    const label = link.channel.startsWith('D') ? 'Slack DM' : channelLabel ? (channelLabel.startsWith('#') ? channelLabel : `#${channelLabel}`) : `Slack ${link.channel}`;
    return {
      source: 'slack',
      kind: 'slack_thread',
      externalId: `${link.channel}:${parent}`,
      title: `${label}: ${messages[0].text.slice(0, 80)}`,
      url: undefined,
      data: { messages, slack: { channel: link.channel, channelName: channelLabel, threadTs: parent } },
      eventId: `${link.channel}:${messages[messages.length - 1].id}`,
    } as InboundItem;
  } finally {
    await conn.close();
  }
}

/** Add what a pasted link points at to a work stream. The PU asked for it, so it makes no noise (no unread dot). */
export async function addWorkItemFromUrl(d: Deps, streamId: string, rawUrl: string): Promise<{ item: StreamItem; created: boolean; link: ParsedLink }> {
  const link = parseWorkItemUrl(rawUrl);
  const stream = await d.repo.getStream(streamId);
  if (!stream) throw new Error('Work stream not found');

  if (link.kind === 'doc') {
    const docs = await d.hub.api('docs').catch(() => null);
    const existed = (await d.repo.findItem('drive', `${link.id}@${streamId}`)) !== null;
    return { item: await attachDriveFile(d.repo, docs, streamId, { id: link.id, url: link.url }, { quiet: true }), created: !existed, link };
  }

  const inbound = await fetchInbound(link, d);
  if (link.kind === 'slack') return addSlackFromLink(d, streamId, link, inbound);
  const there = await d.repo.findItem(inbound.source, inbound.externalId);
  if (there?.streamId === streamId) return { item: there, created: false, link };
  if (there?.streamId) {
    const other = await d.repo.getStream(there.streamId);
    throw new Error(`That item is already in the work stream "${other?.title ?? 'another stream'}". Drag its tab here to move it.`);
  }
  const { item } = await d.repo.upsertItem({ ...inbound, streamId });
  if (item.streamId !== streamId) await d.repo.attachItem(item.id, streamId);
  // A Slack message from a channel this stream already has joins that channel's item.
  if (item.source === 'slack') await d.repo.mergeSiblingChannelItems(streamId);
  const kept = (await d.repo.getItem(item.id)) ?? (await d.repo.findAliasItem(inbound.externalId)) ?? item;
  return { item: kept, created: true, link };
}

/**
 * A Slack link is a point in a conversation: the work stream gets that message and what follows it, never what came before.
 * The messages go into the stream's own item for the conversation. Other streams may hold the rest of the same conversation
 * (it is split by topic), so a message the link names is moved here from wherever it was, together with the messages after it
 * that sat in the same place. Messages other work streams hold are left with them.
 */
async function addSlackFromLink(d: Deps, streamId: string, link: Extract<ParsedLink, { kind: 'slack' }>, inbound: InboundItem) {
  const channel = link.channel;
  const family = await d.repo.slackFamily(channel);
  const flat = channel.startsWith('D') || /^Group DM/i.test(inbound.data.slack?.channelName ?? '') || Repo.slackIsFlat(channel, family);
  const onwards = (inbound.data.messages ?? []).filter((m) => Number(m.id) >= Number(link.ts));
  if (!onwards.length) throw new Error("Couldn't read that Slack message (are you in that channel?)");
  const holder = family.find((i) => i.data.messages?.some((m) => m.id === link.ts));
  const alreadyHere = holder?.streamId === streamId && onwards.every((m) => holder.data.messages?.some((x) => x.id === m.id));
  const known = new Map<string, ThreadMessage>();
  for (const m of holder?.data.messages ?? []) if (Number(m.id) >= Number(link.ts)) known.set(m.id, m);
  for (const m of onwards) known.set(m.id, m);
  const res = await d.repo.placeSlackMessages({
    channel,
    toStreamId: streamId,
    messages: [...known.values()],
    title: holder?.title ?? inbound.title,
    channelName: inbound.data.slack?.channelName,
    flat,
  });
  const item = res.item!;
  for (const m of res.moved) {
    if (!m.streamId || m.streamId === streamId) continue;
    const from = await d.repo.getStream(m.streamId);
    const to = await d.repo.getStream(streamId);
    await d.repo.addChat({ streamId: m.streamId, role: 'system', content: `${m.count} message${m.count === 1 ? '' : 's'} from "${m.title}" moved to "${to?.title ?? 'another work stream'}" because you added a link to them there.` });
    await d.repo.addChat({ streamId, role: 'system', content: `${m.count} message${m.count === 1 ? '' : 's'} moved here from "${from?.title ?? 'another work stream'}".` });
  }
  return { item, created: !alreadyHere, link } as { item: StreamItem; created: boolean; link: ParsedLink };
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/g;
const sameUrl = (u: string) => u.trim().replace(/[.,;:!?]+$/, '').replace(/\/+$/, '');

/**
 * The guard for Claude adding a link: it must be one the PU themselves wrote in the stream's recent chat. Text that arrived from
 * email, Slack or tickets can never satisfy it, so an instruction hidden in a message can't make Claude pull something in.
 */
export function urlInPuMessages(url: string, chat: { role: string; content: string }[]) {
  const want = sameUrl(url);
  return chat
    .filter((m) => m.role === 'user')
    .slice(-3)
    .some((m) => (m.content.match(URL_IN_TEXT) ?? []).some((u) => sameUrl(u) === want));
}
