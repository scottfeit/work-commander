import type { OutFile } from '../core/attachments.js';
import type { ItemData, ItemSource, StreamItem, ThreadMessage } from '@wc/shared';

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
  reply(input: { threadId: string; to: string[]; cc: string[]; subject: string; body: string; files?: OutFile[] }): Promise<{ messageId: string; threadId: string }>;
  send(input: { to: string[]; cc: string[]; subject: string; body: string; files?: OutFile[] }): Promise<{ messageId: string; threadId: string }>;
}

export interface DocsApi {
  search(query: string, max?: number): Promise<{ id: string; title: string; url: string; mimeType: string; modified: string }[]>;
  read(fileId: string): Promise<{ title: string; text: string; url: string }>;
}

export interface CalendarApi {
  list(input: { from: string; to: string; query?: string }): Promise<{ id: string; title: string; start: string; end: string; attendees: string[]; url?: string }[]>;
}

export interface ChatApi {
  selfUserId(): Promise<string>;
  getThread(channel: string, threadTs: string): Promise<InboundItem>;
  search(query: string, max?: number): Promise<{ channel: string; ts: string; threadTs?: string; user: string; text: string; permalink: string }[]>;
  postMessage(input: { channel?: string; userEmail?: string; userId?: string; text: string; threadTs?: string; files?: OutFile[] }): Promise<{ channel: string; ts: string; permalink?: string }>;
  lookupUserByEmail(email: string): Promise<{ id: string; name: string } | null>;
}

export interface TicketApi {
  myself(): Promise<{ accountId: string; email?: string; displayName: string }>;
  getIssue(key: string): Promise<InboundItem>;
  search(jql: string, max?: number): Promise<{ key: string; summary: string; status: string; updated: string }[]>;
  createJsmRequest(input: { serviceDeskId: string; requestTypeId: string; summary: string; description: string; requesterEmail: string; assignToSelf: boolean }): Promise<{ key: string; url: string }>;
  createJiraIssue(input: { projectKey: string; issueType: string; summary: string; description: string; requesterEmail?: string; assignToSelf: boolean }): Promise<{ key: string; url: string }>;
  comment(input: { key: string; body: string; public: boolean; flavor: 'jsm' | 'jira'; files?: OutFile[] }): Promise<{ id: string }>;
  /** Attach files to an issue (used after creating a ticket). */
  attach(input: { key: string; files: OutFile[] }): Promise<{ count: number }>;
  transition(input: { key: string; to: string; resolution?: string }): Promise<{ status: string }>;
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
