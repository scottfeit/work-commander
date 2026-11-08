import { z } from 'zod';
import type { ItemSource, Settings } from '@wc/shared';
import type { Repo } from '../core/repo.js';
import type { SecretStore } from '../secrets/store.js';
import type { InboundSink, Ingestor } from '../integrations/types.js';
import { isReadOnlyTool, toSdkMcpConfig } from '../integrations/mcp.js';
import type { AgentBackend } from './backend.js';

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
  slack: 'Find Slack messages after {since} that are direct messages to the PU, mention the PU, or reply in threads the PU is in.',
  atlassian: 'Find Jira/JSM issues updated after {since} that are assigned to, reported by, or watched by the PU. Include comments.',
};

const SOURCE: Record<'google' | 'slack' | 'atlassian', ItemSource> = { google: 'gmail', slack: 'slack', atlassian: 'jira' };
const KIND = { google: 'email_thread', slack: 'slack_thread', atlassian: 'ticket' } as const;

/**
 * Ingestion for systems connected through an MCP server. MCP has no standard "subscribe" or
 * "list since" call, so on each poll Claude uses the server's read-only tools to collect new
 * activity and return it in a fixed shape. Only polling is possible in this mode.
 */
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

  async pollOnce() {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = await this.settings();
      const m = s[this.system].mcp;
      if (!m) throw new Error('MCP server not configured');
      const key = `mcp.${this.system}.since`;
      const since = (await this.repo.getSync(key)) || new Date(Date.now() - 86400_000).toISOString();
      const started = new Date().toISOString();
      const config = await toSdkMcpConfig(m, (id) => this.secrets.get(id));
      const ext = [{ name: this.system, system: this.system, settings: m, config }];
      const instruction = (m.ingestionPrompt || DEFAULTS[this.system]).replaceAll('{since}', since);
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
          isFromPU: !!x.authorEmail && x.authorEmail.toLowerCase() === pu,
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
