import { WebClient } from '@slack/web-api';
import type { SlackSettings, ThreadMessage } from '@wc/shared';
import type { ChatApi, InboundItem, InboundSink, Ingestor } from './types.js';
import type { Repo } from '../core/repo.js';
import type { OutFile } from '../core/attachments.js';

/**
 * Slack via a *user* token (xoxp-) so approved messages post as the PU. Socket Mode (app-level
 * token, xapp-) delivers events subscribed "on behalf of users" for real-time ingestion.
 */
export class SlackWorkspace implements ChatApi {
  web: WebClient;
  private uid?: string;
  private teamUrl?: string;
  private names = new Map<string, { name: string; email?: string }>();
  constructor(token: string) {
    this.web = new WebClient(token);
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

  /** A whole DM conversation as one item: recent history including the PU's own messages. */
  async getDmConversation(channel: string, triggerTs?: string): Promise<InboundItem> {
    const me = await this.selfUserId();
    const h = await this.web.conversations.history({ channel, limit: 50 });
    const msgs = ((h.messages ?? []) as any[]).sort((a, b) => Number(a.ts) - Number(b.ts));
    const messages: ThreadMessage[] = [];
    for (const m of msgs) {
      const u = m.user ? await this.user(m.user) : { name: m.username ?? 'bot' };
      messages.push({ id: m.ts, author: { name: u.name, email: (u as any).email, slackUserId: m.user }, text: await this.render(m.text ?? ''), at: new Date(Number(m.ts) * 1000).toISOString(), isFromPU: m.user === me });
    }
    const chName = await this.channelName(channel);
    return {
      source: 'slack',
      kind: 'slack_thread',
      externalId: `${channel}:dm`,
      title: chName,
      data: { messages, slack: { channel, channelName: chName, threadTs: msgs[0]?.ts ?? '' } },
      eventId: `${channel}:${triggerTs ?? msgs[msgs.length - 1]?.ts ?? 'dm'}`,
    };
  }

  async search(query: string, max = 10) {
    const r = await this.web.search.messages({ query, count: max, sort: 'timestamp' });
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

export class SlackIngestor implements Ingestor {
  private socket?: any;
  private timer?: NodeJS.Timeout;
  private busy = false;
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
  async pollOnce() {
    if (this.busy) return;
    this.busy = true;
    try {
      const me = await this.slack.selfUserId();
      const since = Number((await this.repo.getSync('slack.lastTs')) || Date.now() / 1000 - 3 * 86400);
      let maxTs = since;
      const seen = new Set<string>();
      const emit = async (channel: string, threadTs: string, ts: string) => {
        const k = `${channel}:${threadTs}`;
        if (seen.has(k)) return;
        seen.add(k);
        await this.sink(await this.slack.getThread(channel, threadTs, ts));
        maxTs = Math.max(maxTs, Number(ts));
      };
      for (const m of await this.slack.search(`<@${me}>`, 20)) if (Number(m.ts) > since && m.channel) await emit(m.channel, m.threadTs ?? m.ts, m.ts);
      const ims = await this.slack.web.conversations.list({ types: 'im,mpim', exclude_archived: true, limit: 100 });
      for (const c of (ims.channels ?? []).slice(0, 60)) {
        const h = await this.slack.web.conversations.history({ channel: c.id!, oldest: String(since), limit: 20 });
        const msgs = (h.messages ?? []) as any[];
        if (c.is_im) {
          // A DM is one conversation item; new messages from either side (the PU's own replies too) update it.
          if (msgs.length && !seen.has(c.id!)) {
            seen.add(c.id!);
            const newest = msgs.reduce((a, b) => (Number(b.ts) > Number(a.ts) ? b : a)).ts;
            await this.sink(await this.slack.getDmConversation(c.id!, newest));
            maxTs = Math.max(maxTs, Number(newest));
          }
        } else for (const m of msgs) if (m.user !== me) await emit(c.id!, m.thread_ts ?? m.ts, m.ts);
      }
      for (const k of await this.trackedThreads()) {
        const [channel, threadTs] = k.split(':');
        const r = await this.slack.web.conversations.replies({ channel, ts: threadTs, oldest: String(since), limit: 50 });
        const fresh = ((r.messages ?? []) as any[]).filter((m) => Number(m.ts) > since);
        if (fresh.length) await emit(channel, threadTs, fresh[fresh.length - 1].ts);
      }
      await this.repo.setSync('slack.lastTs', String(maxTs));
      this.status(true, 'Slack synced');
    } catch (e: any) {
      this.status(false, `Slack: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }
}
