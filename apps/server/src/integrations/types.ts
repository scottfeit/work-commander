import type { OutFile } from '../core/attachments.js';
import type { GmailAction, GmailThreadState, ItemData, ItemSource, MessageAttachment, StreamItem, ThreadMessage } from '@wc/shared';

/** What every ingestion source hands to the triage pipeline. */
export interface InboundItem {
  source: ItemSource;
  kind: StreamItem['kind'];
  /** Stable key of the thread/ticket (e.g. Gmail threadId, `C123:1700000.0001`, `OPS-12`). */
  externalId: string;
  title: string;
  url?: string;
  data: ItemData;
  /** Unique id of the event that triggered this (message id, comment id...). Used for dedupe. */
  eventId: string;
}

export type InboundSink = (item: InboundItem) => Promise<void>;

export interface Ingestor {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** One poll cycle, also used by "Sync now". */
  pollOnce?(): Promise<void>;
}

export interface EmailApi {
  getThread(threadId: string): Promise<InboundItem>;
  search(query: string, max?: number): Promise<{ threadId: string; subject: string; from: string; snippet: string; at: string }[]>;
  /** `html`: an HTML version sent alongside the plain text (multipart/alternative). */
  reply(input: { threadId: string; to: string[]; cc: string[]; subject: string; body: string; html?: string; files?: OutFile[] }): Promise<{ messageId: string; threadId: string }>;
  send(input: { to: string[]; cc: string[]; subject: string; body: string; html?: string; files?: OutFile[] }): Promise<{ messageId: string; threadId: string }>;
  /** The PU's Gmail signature (their default send-as address's), or null. */
  signature?(): Promise<{ html: string; text: string } | null>;
  /** Mark read/unread, archive/unarchive, or trash/untrash a whole thread. `toInbox` with untrash: put it back in the Inbox too. */
  modifyThread?(threadId: string, action: GmailAction, opts?: { toInbox?: boolean }): Promise<void>;
  /** Where the thread is now (read, archived, in Trash). */
  threadState?(threadId: string): Promise<GmailThreadState>;
  /** An attachment's bytes. */
  attachment?(messageId: string, a: MessageAttachment): Promise<Buffer>;
}

export interface DocsApi {
  search(query: string, max?: number): Promise<{ id: string; title: string; url: string; mimeType: string; modified: string }[]>;
  read(fileId: string): Promise<{ title: string; text: string; url: string }>;
}

export interface CalendarApi {
  list(input: { from: string; to: string; query?: string }): Promise<{ id: string; title: string; start: string; end: string; attendees: string[]; url?: string }[]>;
}

export interface ChatApi {
  /** A file's bytes, from its private URL. */
  download?(url: string): Promise<Buffer>;
  /** Add or remove the PU's emoji reaction on a message. */
  react?(channel: string, ts: string, name: string, add: boolean): Promise<void>;
  /** Whether the PU has unread messages in a conversation (DM, group DM or channel) in Slack. */
  readState?(channel: string): Promise<{ unread: boolean }>;
  /** Mark a whole conversation read (up to its latest message) or unread (from its latest message) in Slack. */
  markConversation?(channel: string, read: boolean): Promise<{ unread: boolean }>;
  /** Current reactions on these messages (one call). */
  reactionsFor?(channel: string, threadTs: string | null, ts: string[]): Promise<Map<string, ThreadMessage['reactions']>>;
  /** The workspace's own emoji: name -> image URL. */
  customEmoji?(): Promise<Record<string, string>>;
  selfUserId(): Promise<string>;
  getThread(channel: string, threadTs: string): Promise<InboundItem>;
  search(query: string, max?: number): Promise<{ channel: string; ts: string; threadTs?: string; user: string; text: string; permalink: string }[]>;
  postMessage(input: { channel?: string; userEmail?: string; userId?: string; text: string; threadTs?: string; files?: OutFile[] }): Promise<{ channel: string; ts: string; permalink?: string }>;
  lookupUserByEmail(email: string): Promise<{ id: string; name: string } | null>;
}

export interface TicketApi {
  /** An attachment's bytes, from its content URL. */
  download?(url: string): Promise<Buffer>;
  myself(): Promise<{ accountId: string; email?: string; displayName: string }>;
  getIssue(key: string): Promise<InboundItem>;
  search(jql: string, max?: number): Promise<{ key: string; summary: string; status: string; updated: string }[]>;
  createJsmRequest(input: { serviceDeskId: string; requestTypeId: string; summary: string; description: string; requesterEmail: string; assignToSelf: boolean }): Promise<{ key: string; url: string }>;
  createJiraIssue(input: { projectKey: string; issueType: string; summary: string; description: string; requesterEmail?: string; assignToSelf: boolean }): Promise<{ key: string; url: string }>;
  comment(input: { key: string; body: string; public: boolean; flavor: 'jsm' | 'jira'; files?: OutFile[]; mentions?: { name: string; email?: string }[] }): Promise<{ id: string }>;
  /** Attach files to an issue (used after creating a ticket). */
  attach(input: { key: string; files: OutFile[] }): Promise<{ count: number }>;
  /** Move by transition id, or to a status (or transition) by name. `fields`: values for fields the transition requires (an allowed value as { id }). */
  transition(input: { key: string; to: string; id?: string; resolution?: string; fields?: Record<string, string | { id: string }> }): Promise<{ status: string }>;
  /** Where the ticket can move to now, with the fields each move requires. */
  transitionOptions?(key: string): Promise<import('@wc/shared').TicketTransitionOption[]>;
  /** The assignee's Jira account id (null = unassigned). */
  assigneeOf?(key: string): Promise<string | null>;
  /** Set the assignee: an email address, "me" (the PU), "accountId:<id>", or null to unassign. */
  assign(input: { key: string; assignee: string | null }): Promise<{ assignee: string | null }>;
  /**
   * Link issues: each of `keys` gets a link of this relation ("relates to", "blocks", "is blocked by", "duplicates", … or a link
   * type's name) to `to`. Returns the link type used and how each key was linked.
   */
  linkIssues?(input: { keys: string[]; to: string; relation: string }): Promise<{ type: string; linked: string[] }>;
  /** Put issues under an epic (its key), or take them out of their epic ("none"). */
  setEpic?(input: { keys: string[]; epic: string }): Promise<{ epic: string | null }>;
  /** Move issues to a sprint (its name or id; "active"/"current" or "next" work too), or to the backlog ("backlog"). */
  setSprint?(input: { keys: string[]; sprint: string }): Promise<{ sprint: string }>;
  confluenceSearch(query: string, max?: number): Promise<{ id: string; title: string; url: string; excerpt: string }[]>;
  confluenceRead(pageId: string): Promise<{ title: string; text: string; url: string }>;
  listServiceDesks(): Promise<{ id: string; projectKey: string; name: string }[]>;
  listRequestTypes(serviceDeskId: string): Promise<{ id: string; name: string }[]>;
}

export const htmlToText = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Strip quoted history from an email body so triage sees the new content. */
export function stripQuoted(text: string) {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const l of lines) {
    if (/^On .+wrote:$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l) || /^From: .+/.test(l) && out.length > 0) break;
    if (l.startsWith('>')) continue;
    out.push(l);
  }
  return out.join('\n').trim();
}

export type { ThreadMessage };
