import { z } from 'zod';
import type { ItemSource, Settings, StreamItem } from '@wc/shared';
import type { Repo } from '../core/repo.js';
import type { SecretStore } from '../secrets/store.js';
import type { InboundSink, Ingestor } from '../integrations/types.js';
import { isReadOnlyTool, toSdkMcpConfig } from '../integrations/mcp.js';
import type { AgentBackend } from './backend.js';
import { parseWatchedChannels } from '../integrations/slack.js';

const Polled = z.object({
  items: z.array(
    z.object({
      externalId: z.string().describe('Stable id of the thread / Slack thread (channel:thread_ts) / ticket key'),
      title: z.string(),
      url: z.string().nullable(),
      messages: z.array(z.object({ id: z.string(), authorName: z.string().nullable(), authorEmail: z.string().nullable(), text: z.string(), at: z.string(), to: z.array(z.string()).nullable(), cc: z.array(z.string()).nullable() })),
      ticket: z.object({ key: z.string(), summary: z.string(), status: z.string(), assignee: z.string().nullable(), requester: z.string().nullable(), description: z.string().nullable(), flavor: z.enum(['jsm', 'jira']) }).nullable(),
    }),
  ),
});

const DEFAULTS: Record<'google' | 'slack' | 'atlassian', string> = {
  google: 'Find email threads in the PU\'s inbox with messages received after {since}. Skip newsletters and promotions.',
  slack:
    'Find Slack messages after {since} that are direct messages to the PU, mention the PU, or reply in threads the PU is in. ' +
    'A direct-message conversation is ONE item: use externalId "<DM channel id>:dm" (the D… id) and put every new message in it, ' +
    'including messages the PU wrote themself (e.g. replies sent from Slack directly), with authorName set to the sender\'s display name. ' +
    'Also return the PU\'s own new messages in DM conversations and threads that already exist, even when nobody else has written since.',
  atlassian: 'Find Jira/JSM issues updated after {since} that are assigned to, reported by, or watched by the PU. Include comments.',
};

/** How far before the previous poll each poll looks, to catch messages search had not indexed yet. */
const OVERLAP_MS = 10 * 60_000;

const SOURCE: Record<'google' | 'slack' | 'atlassian', ItemSource> = { google: 'gmail', slack: 'slack', atlassian: 'jira' };
const KIND = { google: 'email_thread', slack: 'slack_thread', atlassian: 'ticket' } as const;

/**
 * Ingestion for systems connected through an MCP server. MCP has no standard "subscribe" or
 * "list since" call, so on each poll Claude uses the server's read-only tools to collect new
 * activity and return it in a fixed shape. Only polling is possible in this mode.
 */
/**
 * Which Slack items to re-read on every poll. DMs and group DMs are flat, so their history is read from the newest message we hold.
 * A thread in a channel is different: its replies never appear in the channel's history, so each thread (and every thread folded into
 * a "#channel" item) is re-read by its parent message.
 */
export function planTrackedSlackReads(items: StreamItem[], opts: { skipMuted?: boolean } = {}) {
  const latest = new Map<string, string>();
  const threads = new Map<string, { channel: string; ts: string }>();
  for (const it of items) {
    if (it.source !== 'slack') continue;
    if (opts.skipMuted && it.data.muted) continue; // "don't poll silenced items"
    const channel = it.data.slack?.channel ?? it.externalId.split(':')[0];
    const flat = channel.startsWith('D') || it.externalId.endsWith(':dm') || it.externalId === channel;
    if (flat) {
      const at = (it.data.messages ?? []).filter((m) => !m.id.startsWith('sent-')).map((m) => m.at).sort().pop() ?? it.updatedAt;
      if (!latest.has(channel) || at > latest.get(channel)!) latest.set(channel, at);
      continue;
    }
    for (const id of [it.externalId, ...(it.data.mergedExternalIds ?? [])]) {
      const m = /^([A-Z][A-Z0-9]+):(\d+\.\d+)$/.exec(id);
      if (m) threads.set(id, { channel: m[1], ts: m[2] });
    }
  }
  return {
    conversations: [...latest].slice(0, 20).map(([channel, after]) => ({ channel, after })),
    threads: [...threads.values()].slice(0, 20),
  };
}

export class McpPollIngestor implements Ingestor {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(
    private system: 'google' | 'slack' | 'atlassian',
    private backend: AgentBackend,
    private settings: () => Promise<Settings>,
    private secrets: SecretStore,
    private repo: Repo,
    private sink: InboundSink,
    private status: (ok: boolean, msg: string) => void,
  ) {}

  async start() {
    const s = await this.settings();
    await this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), Math.max(120, s[this.system].pollSeconds) * 1000);
  }
  async stop() {
    clearInterval(this.timer);
  }

  /** What to re-read for the Slack items in open work streams (see planTrackedSlackReads). */
  private async trackedSlackReads() {
    const items: StreamItem[] = [];
    for (const st of await this.repo.listStreams(false)) items.push(...(await this.repo.listItems(st.id)));
    return planTrackedSlackReads(items, { skipMuted: !!(await this.settings()).silencing?.skipPolling });
  }

  async pollOnce() {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = await this.settings();
      const m = s[this.system].mcp;
      if (!m) throw new Error('MCP server not configured');
      const key = `mcp.${this.system}.since`;
      const lastRun = (await this.repo.getSync(key)) || new Date(Date.now() - 86400_000).toISOString();
      // Search indexes lag and a miss would otherwise be permanent, so look back past the last run. Repeats are harmless: messages merge by id.
      const since = new Date(Math.min(Date.parse(lastRun) - OVERLAP_MS, Date.now())).toISOString();
      const started = new Date().toISOString();
      const config = await toSdkMcpConfig(m, (id) => this.secrets.get(id));
      const ext = [{ name: this.system, system: this.system, settings: m, config }];
      let instruction = (m.ingestionPrompt || DEFAULTS[this.system]).replaceAll('{since}', since);
      if (this.system === 'slack') {
        const watched = parseWatchedChannels(s.slack.watchedChannels);
        if (watched.length)
          instruction +=
            `\nAlso watch these Slack channels: ${watched.map((w) => (/^[CG][A-Z0-9]{6,}$/.test(w) ? w : `#${w}`)).join(', ')}. Find each one (the channel search tool resolves names), read its recent history with the channel-history read tool, ` +
            `and return every top-level message and thread with activity after ${since}, even when it does not mention the PU. One item per thread: externalId "<channel id>:<thread_ts>".`;
        // Conversations already in open work streams are checked directly, not left to Slack search.
        const { conversations, threads } = await this.trackedSlackReads();
        if (conversations.length)
          instruction +=
            '\nAlso read the history of these Slack conversations the PU is already working on and return every message after the time given for each, from anyone including the PU. ' +
            'Use the channel-history read tool for each; do not rely on search for them.\n' +
            conversations.map((c) => `- channel ${c.channel}: messages after ${c.after}`).join('\n');
        if (threads.length)
          instruction +=
            '\nAlso re-read these Slack threads the PU is following. Replies do not show up in channel history, so use the thread-read tool (channel id + parent message ts) for each, ' +
            'and return the whole current thread (the parent and every reply) as one item with externalId "<channel id>:<thread_ts>", from anyone including the PU.\n' +
            threads.map((t) => `- thread ${t.channel}:${t.ts}`).join('\n');
      }
      const r = await this.backend.structured({
        systemPrompt: `You collect new work activity for ${s.pu.name} <${s.pu.email}> using read-only tools. Return only items with activity after the given time, with full message text. Return an empty list if nothing is new.`,
        prompt: instruction,
        schema: Polled,
        external: ext,
        canUseExternal: async (_srv, tool, input) =>
          isReadOnlyTool(tool, m) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only read-only tools may be used while collecting activity.' },
      });
      const pu = s.pu.email.toLowerCase();
      for (const it of r.items) {
        const messages = it.messages.map((x) => ({
          id: x.id,
          author: { name: x.authorName ?? undefined, email: x.authorEmail?.toLowerCase() ?? undefined },
          to: x.to ?? undefined,
          cc: x.cc ?? undefined,
          text: x.text,
          at: x.at,
          isFromPU: (!!x.authorEmail && x.authorEmail.toLowerCase() === pu) || (!!x.authorName && x.authorName.trim().toLowerCase() === s.pu.name.trim().toLowerCase()),
        }));
        const last = messages[messages.length - 1];
        await this.sink({
          source: it.ticket?.flavor === 'jsm' ? 'jsm' : SOURCE[this.system],
          kind: KIND[this.system],
          externalId: it.externalId,
          title: it.title,
          url: it.url ?? undefined,
          data: it.ticket
            ? { ticket: { ...it.ticket, assignee: it.ticket.assignee ?? undefined, requester: it.ticket.requester ?? undefined, description: it.ticket.description ?? undefined, comments: messages } }
            : { messages },
          eventId: `${it.externalId}@${last?.id ?? started}`,
        });
      }
      await this.repo.setSync(key, started);
      this.status(true, `${this.system} (MCP) synced: ${r.items.length} items`);
    } catch (e: any) {
      this.status(false, `${this.system} (MCP): ${e.message}`);
    } finally {
      this.busy = false;
    }
  }
}
