import { OAuth2Client } from 'google-auth-library';
import { gmail as gmailApi, type gmail_v1 } from '@googleapis/gmail';
import { drive as driveApi } from '@googleapis/drive';
import { calendar as calendarApi } from '@googleapis/calendar';
import type { GoogleSettings, PrimaryUser, ThreadMessage } from '@wc/shared';
import type { CalendarApi, DocsApi, EmailApi, InboundItem, InboundSink, Ingestor } from './types.js';
import { htmlToText } from './types.js';
import type { Repo } from '../core/repo.js';
import type { OutFile } from '../core/attachments.js';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid',
  'email',
];

export function oauthClient(clientId: string, clientSecret: string, redirectUri: string) {
  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

export async function authedClient(s: GoogleSettings, secret: (id: string) => Promise<string>, redirectUri: string) {
  if (!s.oauth.clientId || !s.oauth.clientSecretId || !s.oauth.refreshTokenId) throw new Error('Google OAuth is not connected');
  const c = oauthClient(s.oauth.clientId, await secret(s.oauth.clientSecretId), redirectUri);
  c.setCredentials({ refresh_token: await secret(s.oauth.refreshTokenId) });
  return c;
}

const header = (m: gmail_v1.Schema$Message, name: string) =>
  m.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

function decode(data?: string | null) {
  return data ? Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : '';
}

/** The first text/plain and text/html bodies found anywhere in a message (multipart/alternative has both). */
function bodies(part?: gmail_v1.Schema$MessagePart): { plain?: string; html?: string } {
  if (!part) return {};
  if (part.mimeType === 'text/plain' && part.body?.data) return { plain: decode(part.body.data) };
  if (part.mimeType === 'text/html' && part.body?.data) return { html: decode(part.body.data) };
  const out: { plain?: string; html?: string } = {};
  for (const p of part.parts ?? []) {
    const b = bodies(p);
    out.plain ??= b.plain;
    out.html ??= b.html;
  }
  return out;
}

export function bodyOf(part?: gmail_v1.Schema$MessagePart): { text: string; html?: string } {
  const { plain, html } = bodies(part);
  return { text: plain || (html ? htmlToText(html) : ''), html };
}

/** "Name <a@b.c>, d@e.f" -> ["a@b.c","d@e.f"] */
export function parseAddressList(v: string): string[] {
  return (v.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? []).map((a) => a.toLowerCase());
}
function parseFrom(v: string) {
  const email = parseAddressList(v)[0];
  const name = v.replace(/<[^>]+>/, '').replace(/"/g, '').trim();
  return { email, name: name && name !== email ? name : undefined };
}

export function encodeEmail(input: Parameters<typeof buildMime>[0]) {
  return Buffer.from(buildMime(input)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The RFC 822 message as text; multipart/mixed when there are attachments. */
export function buildMime(input: {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  files?: OutFile[];
}) {
  const subj = /[^\x20-\x7e]/.test(input.subject) ? `=?UTF-8?B?${Buffer.from(input.subject).toString('base64')}?=` : input.subject;
  const b64 = (b: Buffer) => b.toString('base64').replace(/.{76}/g, '$&\r\n');
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
    ...(input.cc.length ? [`Cc: ${input.cc.join(', ')}`] : []),
    `Subject: ${subj}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${[input.references, input.inReplyTo].filter(Boolean).join(' ')}`] : []),
    'MIME-Version: 1.0',
  ];
  const textPart = ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(input.body, 'utf8'))];
  let lines: string[];
  if (!input.files?.length) {
    lines = [...headers, ...textPart];
  } else {
    const boundary = `wc_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    // RFC 2231 filename* keeps non-ASCII names intact; the plain filename is an ASCII fallback.
    const fname = (n: string) => `filename="${n.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(n)}`;
    lines = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...textPart];
    for (const f of input.files) {
      lines.push(`--${boundary}`, `Content-Type: ${f.mimeType}`, `Content-Disposition: attachment; ${fname(f.filename)}`, 'Content-Transfer-Encoding: base64', '', b64(f.data));
    }
    lines.push(`--${boundary}--`, '');
  }
  return lines.join('\r\n');
}

export class GoogleWorkspace implements EmailApi, CalendarApi {
  gmail: gmail_v1.Gmail;
  private driveC;
  private cal;
  constructor(private auth: OAuth2Client, private pu: () => Promise<PrimaryUser>) {
    this.gmail = gmailApi({ version: 'v1', auth: auth as any });
    this.driveC = driveApi({ version: 'v3', auth: auth as any });
    this.cal = calendarApi({ version: 'v3', auth: auth as any });
  }

  async profile() {
    const r = await this.gmail.users.getProfile({ userId: 'me' });
    return { email: r.data.emailAddress!, historyId: r.data.historyId! };
  }

  toInbound(thread: gmail_v1.Schema$Thread, puEmail: string, triggerId?: string): InboundItem {
    const msgs = thread.messages ?? [];
    const messages: ThreadMessage[] = msgs.map((m) => {
      const from = parseFrom(header(m, 'From'));
      const b = bodyOf(m.payload);
      return {
        id: m.id!,
        author: from,
        to: parseAddressList(header(m, 'To')),
        cc: parseAddressList(header(m, 'Cc')),
        subject: header(m, 'Subject'),
        text: b.text || m.snippet || '',
        html: b.html,
        at: new Date(Number(m.internalDate ?? Date.now())).toISOString(),
        isFromPU: from.email === puEmail.toLowerCase() || (m.labelIds ?? []).includes('SENT'),
      };
    });
    const last = msgs[msgs.length - 1];
    return {
      source: 'gmail',
      kind: 'email_thread',
      externalId: thread.id!,
      title: header(msgs[0] ?? {}, 'Subject') || '(no subject)',
      url: `https://mail.google.com/mail/u/0/#all/${thread.id}`,
      data: {
        messages,
        gmail: { threadId: thread.id!, lastMessageIdHeader: last ? header(last, 'Message-ID') : undefined, references: last ? header(last, 'References') : undefined },
      },
      eventId: triggerId ?? last?.id ?? thread.id!,
    };
  }

  async getThread(threadId: string, triggerId?: string) {
    const t = await this.gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
    return this.toInbound(t.data, (await this.pu()).email, triggerId);
  }

  async search(query: string, max = 10) {
    const r = await this.gmail.users.threads.list({ userId: 'me', q: query, maxResults: max });
    const out = [];
    for (const t of r.data.threads ?? []) {
      const full = await this.gmail.users.threads.get({ userId: 'me', id: t.id!, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
      const first = full.data.messages?.[0];
      out.push({
        threadId: t.id!,
        subject: first ? header(first, 'Subject') : '',
        from: first ? header(first, 'From') : '',
        snippet: t.snippet ?? '',
        at: first?.internalDate ? new Date(Number(first.internalDate)).toISOString() : '',
      });
    }
    return out;
  }

  private async fromHeader() {
    const pu = await this.pu();
    return pu.name ? `${pu.name} <${pu.email}>` : pu.email;
  }

  async reply(input: { threadId: string; to: string[]; cc: string[]; subject: string; body: string; files?: OutFile[] }) {
    const t = await this.gmail.users.threads.get({ userId: 'me', id: input.threadId, format: 'metadata', metadataHeaders: ['Message-ID', 'References', 'Subject'] });
    const last = t.data.messages?.[t.data.messages.length - 1];
    const subject = input.subject || (last ? header(last, 'Subject') : '');
    const msg = {
      from: await this.fromHeader(),
      to: input.to,
      cc: input.cc,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      body: input.body,
      inReplyTo: last ? header(last, 'Message-ID') : undefined,
      references: last ? header(last, 'References') : undefined,
      files: input.files,
    };
    const r = await this.sendMime(msg, input.threadId);
    return { messageId: r.data.id!, threadId: r.data.threadId! };
  }

  /** Small messages go inline as `raw`; messages with attachments use the media upload endpoint, which allows up to 35 MB. */
  private sendMime(msg: Parameters<typeof buildMime>[0], threadId?: string) {
    if (!msg.files?.length) return this.gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodeEmail(msg), threadId } });
    return this.gmail.users.messages.send({ userId: 'me', requestBody: { threadId }, media: { mimeType: 'message/rfc822', body: buildMime(msg) } });
  }

  async send(input: { to: string[]; cc: string[]; subject: string; body: string; files?: OutFile[] }) {
    const r = await this.sendMime({ from: await this.fromHeader(), ...input });
    return { messageId: r.data.id!, threadId: r.data.threadId! };
  }

  // Drive
  async searchDocs(query: string, max = 10) {
    const q = `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`;
    const r = await this.driveC.files.list({ q, pageSize: max, fields: 'files(id,name,mimeType,webViewLink,modifiedTime)', supportsAllDrives: true, includeItemsFromAllDrives: true });
    return (r.data.files ?? []).map((f) => ({ id: f.id!, title: f.name!, url: f.webViewLink ?? '', mimeType: f.mimeType ?? '', modified: f.modifiedTime ?? '' }));
  }

  async read(fileId: string) {
    const meta = await this.driveC.files.get({ fileId, fields: 'name,mimeType,webViewLink', supportsAllDrives: true });
    const mime = meta.data.mimeType ?? '';
    let text = '';
    if (mime.startsWith('application/vnd.google-apps.')) {
      const exportMime = mime.endsWith('spreadsheet') ? 'text/csv' : 'text/plain';
      const r = await this.driveC.files.export({ fileId, mimeType: exportMime }, { responseType: 'text' });
      text = String(r.data);
    } else if (mime.startsWith('text/') || mime === 'application/json') {
      const r = await this.driveC.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
      text = String(r.data);
    } else {
      text = `(Binary file of type ${mime}; open it in Drive.)`;
    }
    return { title: meta.data.name ?? fileId, text: text.slice(0, 60_000), url: meta.data.webViewLink ?? '' };
  }

  // Calendar
  async list(input: { from: string; to: string; query?: string }) {
    const r = await this.cal.events.list({ calendarId: 'primary', timeMin: input.from, timeMax: input.to, q: input.query, singleEvents: true, orderBy: 'startTime', maxResults: 50 });
    return (r.data.items ?? []).map((e) => ({
      id: e.id!,
      title: e.summary ?? '(no title)',
      start: e.start?.dateTime ?? e.start?.date ?? '',
      end: e.end?.dateTime ?? e.end?.date ?? '',
      attendees: (e.attendees ?? []).map((a) => a.email!).filter(Boolean),
      url: e.htmlLink ?? undefined,
    }));
  }
}

/** DocsApi adapter (GoogleWorkspace has both `search` for mail and docs). */
export const driveAdapter = (g: GoogleWorkspace): DocsApi => ({ search: (q, m) => g.searchDocs(q, m), read: (id) => g.read(id) });

const SKIP_LABELS = new Set(['SPAM', 'TRASH', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']);

/**
 * Gmail ingestion. Polling walks users.history from the last seen historyId. Realtime uses
 * users.watch -> Pub/Sub (pull subscription, so it also works on a laptop) and then the same
 * history walk when a notification arrives.
 */
export class GmailIngestor implements Ingestor {
  private timer?: NodeJS.Timeout;
  private sub?: { close(): Promise<void> };
  private watchTimer?: NodeJS.Timeout;
  private busy = false;
  constructor(
    private g: GoogleWorkspace,
    private s: GoogleSettings,
    private repo: Repo,
    private sink: InboundSink,
    private status: (ok: boolean, msg: string) => void,
  ) {}

  async start() {
    if (this.s.ingestion === 'off') return;
    await this.pollOnce();
    if (this.s.ingestion === 'realtime') {
      if (!this.s.oauth.pubsubTopic || !this.s.oauth.pubsubSubscription) throw new Error('Gmail real-time needs a Pub/Sub topic and pull subscription (Settings → Google)');
      await this.watch();
      this.watchTimer = setInterval(() => void this.watch().catch((e) => this.status(false, `watch renew failed: ${e.message}`)), 24 * 3600_000);
      const { PubSub } = await import('@google-cloud/pubsub');
      const subscription = new PubSub().subscription(this.s.oauth.pubsubSubscription);
      subscription.on('message', (m) => {
        m.ack();
        void this.pollOnce();
      });
      subscription.on('error', (e) => this.status(false, `Pub/Sub: ${e.message}`));
      this.sub = subscription;
      this.status(true, 'Gmail real-time watch active');
    } else {
      this.timer = setInterval(() => void this.pollOnce(), Math.max(15, this.s.pollSeconds) * 1000);
    }
  }

  private async watch() {
    await this.g.gmail.users.watch({ userId: 'me', requestBody: { topicName: this.s.oauth.pubsubTopic, labelIds: ['INBOX'], labelFilterBehavior: 'include' } });
  }

  async stop() {
    clearInterval(this.timer);
    clearInterval(this.watchTimer);
    await this.sub?.close();
  }

  async pollOnce() {
    if (this.busy) return;
    this.busy = true;
    try {
      const cursor = await this.repo.getSync('gmail.historyId');
      if (!cursor) {
        // First run: backfill recent threads matching the PU's query, then start from now.
        const prof = await this.g.profile();
        const r = await this.g.gmail.users.threads.list({ userId: 'me', q: `${this.s.oauth.gmailQuery} newer_than:3d`, maxResults: 25 });
        for (const t of r.data.threads ?? []) await this.sink(await this.g.getThread(t.id!));
        await this.repo.setSync('gmail.historyId', prof.historyId);
      } else {
        let pageToken: string | undefined;
        let latest = cursor;
        const threads = new Map<string, string>();
        do {
          // labelAdded catches mail that arrives elsewhere (e.g. Spam) and is later moved to the inbox.
          const h = await this.g.gmail.users.history.list({ userId: 'me', startHistoryId: cursor, historyTypes: ['messageAdded', 'labelAdded'], pageToken });
          const consider = (m: { id?: string | null; threadId?: string | null; labelIds?: string[] | null }) => {
            const labels = m.labelIds ?? [];
            if (labels.some((l) => SKIP_LABELS.has(l))) return;
            if (!labels.includes('INBOX') && !labels.includes('SENT')) return;
            threads.set(m.threadId!, m.id!);
          };
          for (const rec of h.data.history ?? []) {
            for (const added of rec.messagesAdded ?? []) consider(added.message!);
            for (const l of rec.labelsAdded ?? []) if (l.labelIds?.includes('INBOX')) consider(l.message!);
          }
          latest = h.data.historyId ?? latest;
          pageToken = h.data.nextPageToken ?? undefined;
        } while (pageToken);
        for (const [threadId, msgId] of threads) await this.sink(await this.g.getThread(threadId, msgId));
        await this.repo.setSync('gmail.historyId', latest);
      }
      this.status(true, 'Gmail synced');
    } catch (e: any) {
      if (e?.code === 404) await this.repo.setSync('gmail.historyId', ''); // history expired; re-backfill
      this.status(false, `Gmail: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }
}
