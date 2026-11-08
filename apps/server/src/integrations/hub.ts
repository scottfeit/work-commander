import type { Settings, SystemId } from '@wc/shared';
import type { AppConfig } from '../config.js';
import type { Repo } from '../core/repo.js';
import type { SettingsStore } from '../core/settings.js';
import type { SecretStore } from '../secrets/store.js';
import { bus } from '../core/bus.js';
import type { CalendarApi, ChatApi, DocsApi, EmailApi, InboundSink, Ingestor, TicketApi } from './types.js';
import { GoogleWorkspace, GmailIngestor, authedClient, driveAdapter } from './google.js';
import { SlackIngestor, SlackWorkspace } from './slack.js';
import { AtlassianCloud, JiraIngestor } from './atlassian.js';

export interface Apis {
  email: EmailApi;
  docs: DocsApi;
  calendar: CalendarApi;
  chat: ChatApi;
  tickets: TicketApi;
}

/** Hooks a demo or test world can provide instead of live connectors. */
export interface WorldOverride {
  apis: Partial<Apis>;
  ingestors(sink: InboundSink): Ingestor[];
}

export class IntegrationHub {
  private ingestors: Ingestor[] = [];
  private jira?: JiraIngestor;
  private cache: Partial<Apis> = {};
  private sink: InboundSink = async () => undefined;
  /** Builds agent-driven polling ingestors for systems connected through MCP (set by the agent layer). */
  mcpIngestorFactory?: (system: 'google' | 'slack' | 'atlassian', sink: InboundSink, report: (ok: boolean, msg: string) => void) => Ingestor;
  readonly status: Partial<Record<SystemId, { ok: boolean; message: string; at: string }>> = {};

  constructor(
    private cfg: AppConfig,
    private settings: SettingsStore,
    private secrets: SecretStore,
    private repo: Repo,
    private world?: WorldOverride,
  ) {
    settings.onChange((next, prev) => {
      const keys: (keyof Settings)[] = ['google', 'slack', 'atlassian', 'pu'];
      if (keys.some((k) => JSON.stringify(next[k]) !== JSON.stringify(prev[k]))) void this.restart();
    });
  }

  get redirectUri() {
    return `${this.cfg.publicUrl}/api/oauth/google/callback`;
  }

  private report(system: SystemId) {
    return (ok: boolean, message: string) => {
      const at = new Date().toISOString();
      this.status[system] = { ok, message, at };
      bus.publish({ type: 'ingest.status', system, ok, message, at });
    };
  }

  private secret = (id: string) => this.secrets.get(id);

  /** API-mode client for a system. Throws a clear error if that system is off or in MCP mode. */
  async api<K extends keyof Apis>(k: K): Promise<Apis[K]> {
    if (this.world?.apis[k]) return this.world.apis[k] as Apis[K];
    if (this.cache[k]) return this.cache[k] as Apis[K];
    const s = await this.settings.get();
    const pu = async () => (await this.settings.get()).pu;
    if (k === 'email' || k === 'docs' || k === 'calendar') {
      if (!s.google.enabled || s.google.mode !== 'oauth') throw new Error('Google Workspace is not connected in OAuth mode');
      const g = new GoogleWorkspace(await authedClient(s.google, this.secret, this.redirectUri), pu);
      this.cache.email = g;
      this.cache.calendar = g;
      this.cache.docs = driveAdapter(g);
    } else if (k === 'chat') {
      if (!s.slack.enabled || s.slack.mode !== 'api' || !s.slack.api.userTokenId) throw new Error('Slack is not connected in API mode');
      this.cache.chat = new SlackWorkspace(await this.secret(s.slack.api.userTokenId));
    } else if (k === 'tickets') {
      const a = s.atlassian;
      if (!a.enabled || a.mode !== 'api' || !a.api.apiTokenId) throw new Error('Atlassian is not connected in API mode');
      this.cache.tickets = new AtlassianCloud(a.api.siteUrl, a.api.email, await this.secret(a.api.apiTokenId));
    }
    return this.cache[k] as Apis[K];
  }

  async systemMode(system: 'google' | 'slack' | 'atlassian'): Promise<'api' | 'mcp' | 'off'> {
    const s = await this.settings.get();
    if (this.world) return 'api';
    const x = s[system];
    if (!x.enabled) return 'off';
    return x.mode === 'mcp' ? 'mcp' : 'api';
  }

  async start(sink: InboundSink) {
    this.sink = sink;
    await this.restart();
  }

  async restart() {
    for (const i of this.ingestors) await i.stop().catch(() => undefined);
    this.ingestors = [];
    this.jira = undefined;
    this.cache = {};
    if (this.world) {
      this.ingestors = this.world.ingestors(this.sink);
    } else {
      const s = await this.settings.get();
      const tracked = async (source: string) => {
        const rows = await this.repo.db
          .selectFrom('items')
          .innerJoin('streams', 'streams.id', 'items.stream_id')
          .select('items.external_id')
          .where('streams.status', '=', 'open')
          .where('items.source', '=', source as any)
          .execute();
        return rows.map((r) => r.external_id);
      };
      if (s.google.enabled && s.google.mode === 'oauth' && s.google.oauth.refreshTokenId) {
        try {
          const g = (await this.api('email')) as GoogleWorkspace;
          this.ingestors.push(new GmailIngestor(g, s.google, this.repo, this.sink, this.report('google')));
        } catch (e: any) {
          this.report('google')(false, e.message);
        }
      }
      if (s.slack.enabled && s.slack.mode === 'api' && s.slack.api.userTokenId) {
        try {
          const sl = (await this.api('chat')) as SlackWorkspace;
          const app = s.slack.api.appTokenId ? await this.secret(s.slack.api.appTokenId).catch(() => null) : null;
          this.ingestors.push(new SlackIngestor(sl, s.slack, app, this.repo, async () => new Set(await tracked('slack')), this.sink, this.report('slack')));
        } catch (e: any) {
          this.report('slack')(false, e.message);
        }
      }
      if (s.atlassian.enabled && s.atlassian.mode === 'api' && s.atlassian.api.apiTokenId) {
        try {
          const at = (await this.api('tickets')) as AtlassianCloud;
          const keys = async () => [...(await tracked('jira')), ...(await tracked('jsm'))];
          this.jira = new JiraIngestor(at, s.atlassian, this.repo, keys, this.sink, this.report('atlassian'));
          this.ingestors.push(this.jira);
        } catch (e: any) {
          this.report('atlassian')(false, e.message);
        }
      }
      for (const sys of ['google', 'slack', 'atlassian'] as const) {
        const x = s[sys];
        if (x.enabled && x.mode === 'mcp' && x.ingestion !== 'off' && this.mcpIngestorFactory) {
          this.ingestors.push(this.mcpIngestorFactory(sys, this.sink, this.report(sys)));
        }
      }
    }
    for (const i of this.ingestors) {
      i.start().catch((e) => console.error('[ingest] start failed:', e.message));
    }
  }

  async pollAll() {
    await Promise.all(this.ingestors.map((i) => i.pollOnce?.().catch(() => undefined)));
  }

  async jiraWebhook(payload: unknown) {
    if (!this.jira) throw new Error('Jira ingestion is not running in API mode');
    await this.jira.handleWebhook(payload);
  }

  async stop() {
    for (const i of this.ingestors) await i.stop().catch(() => undefined);
  }
}
