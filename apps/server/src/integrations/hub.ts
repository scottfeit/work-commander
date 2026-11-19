import type { PollingState, Settings, SystemId } from '@wc/shared';
import type { AppConfig } from '../config.js';
import type { Repo } from '../core/repo.js';
import type { SettingsStore } from '../core/settings.js';
import type { SecretStore } from '../secrets/store.js';
import { bus } from '../core/bus.js';
import type { CalendarApi, ChatApi, DocsApi, EmailApi, InboundItem, InboundSink, Ingestor, TicketApi } from './types.js';
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
  /** Paused polling and triage (after a long gap, or by hand); persisted so a restart stays paused. */
  private paused: PollingState['paused'] = null;
  /** Live updates that arrived while paused, newest per conversation; handled on Resume. */
  private held: InboundItem[] = [];
  private catchingUp = false;
  private progress: PollingState['progress'];
  /** Wait before re-reading a source that failed during a catch-up (5 s, 10 s, 20 s … up to a minute). */
  retryDelay = (failures: number) => Math.min(60_000, 5_000 * 2 ** (failures - 1));
  /** While Resume catches up: what the polls bring in, triaged together afterwards. */
  private collected: InboundItem[] | null = null;
  private sinkBatch?: (items: InboundItem[], onDone?: () => void) => Promise<void>;
  /** The last moment polling was known to be running; a jump past the gap setting means the computer slept or the server was off. */
  private lastSeen = 0;
  private gapMs = 2 * 3600_000;
  private ticker?: NodeJS.Timeout;
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
      this.gapMs = Math.max(0, next.polling?.pauseAfterGapHours ?? 2) * 3600_000;
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

  async start(sink: InboundSink, sinkBatch?: (items: InboundItem[], onDone?: () => void) => Promise<void>) {
    this.sink = sink;
    this.sinkBatch = sinkBatch;
    await this.loadPause();
    await this.restart();
    this.ticker = setInterval(() => void this.alive(), 30_000);
    this.ticker.unref?.();
  }

  // ---------- pausing after a gap ----------

  private async loadPause() {
    const s = await this.settings.get();
    this.gapMs = Math.max(0, s.polling?.pauseAfterGapHours ?? 2) * 3600_000;
    const read = async <T>(k: string, d: T): Promise<T> => {
      try {
        const v = await this.repo.getSync(k);
        return v ? (JSON.parse(v) as T) : d;
      } catch {
        return d;
      }
    };
    this.paused = await read<PollingState['paused']>('poll.paused', null);
    this.held = await read<InboundItem[]>('poll.held', []);
    this.lastSeen = Number(await this.repo.getSync('poll.lastSeen').catch(() => null)) || 0;
  }

  get pollingState(): PollingState {
    return { paused: this.paused, held: this.held.length, catchingUp: this.catchingUp, ...(this.progress ? { progress: this.progress } : {}) };
  }

  get isPaused() {
    return !!this.paused;
  }

  private changed() {
    bus.publish({ type: 'polling.changed', polling: this.pollingState });
  }

  private async save() {
    await this.repo.setSync('poll.paused', this.paused ? JSON.stringify(this.paused) : '');
    await this.repo.setSync('poll.held', this.held.length ? JSON.stringify(this.held) : '');
  }

  /**
   * Checked by the 30-second ticker and before every poll. Returns false while paused; pauses (and returns false) when
   * polling hasn't run for longer than the gap setting, so nothing from the gap is fetched or triaged until Resume.
   */
  alive(now = Date.now()): boolean {
    if (this.paused) return false;
    if (this.gapMs > 0 && this.lastSeen && now - this.lastSeen > this.gapMs && this.ingestors.length) {
      void this.pause('gap', new Date(this.lastSeen).toISOString());
      return false;
    }
    this.lastSeen = now;
    void this.repo.setSync('poll.lastSeen', String(now)).catch(() => undefined);
    return true;
  }

  async pause(reason: 'gap' | 'manual', gapFrom?: string) {
    if (this.paused) return this.pollingState;
    this.paused = { since: new Date().toISOString(), reason, ...(gapFrom ? { gapFrom } : {}) };
    await this.save();
    await this.repo.audit('you', 'polling.paused', { reason, gapFrom }).catch(() => undefined);
    this.changed();
    return this.pollingState;
  }

  /** Resume: catch up on the gap from each source's bookmark, then handle what was held, skipping what was cleaned up meanwhile. */
  async resume() {
    if (!this.paused) return this.pollingState;
    this.paused = null;
    this.lastSeen = Date.now();
    await this.repo.setSync('poll.lastSeen', String(this.lastSeen));
    const held = this.held.splice(0);
    await this.save();
    await this.repo.audit('you', 'polling.resumed', { held: held.length }).catch(() => undefined);
    this.catchingUp = true;
    this.changed();
    void (async () => {
      try {
        // Read round after round until a round finds nothing new (a big backlog can take several), retrying a source whose read
        // failed; then add the held updates as they are now, and triage the lot in batches.
        this.collected = [];
        this.progress = { phase: 'reading', round: 0, found: 0, done: 0, total: 0 };
        const key = (i: InboundItem) => `${i.source}:${i.externalId}:${i.eventId}`;
        const found = new Map<string, InboundItem>();
        let failures = 0;
        for (let round = 1; round <= 25; round++) {
          const before = found.size;
          const started = new Date().toISOString();
          this.progress = { ...this.progress, round };
          this.changed();
          await this.pollAll();
          for (const i of this.collected.splice(0)) found.set(key(i), i);
          const failed = Object.entries(this.status).filter(([, v]) => v && !v.ok && v.at >= started).map(([k]) => k);
          this.progress = { ...this.progress, found: found.size, retrying: failed.length ? `couldn't read ${failed.join(', ')}; trying again` : undefined };
          this.changed();
          if (failed.length) {
            if (++failures > 8) break; // give up for now; the regular polls carry on from the bookmarks
            await new Promise((r) => setTimeout(r, this.retryDelay(failures)));
            continue;
          }
          if (found.size === before) break; // nothing new this round: all caught up
        }
        for (const h of held) {
          const cur = await this.current(h).catch(() => (this.cleaned(h) ? null : h));
          if (cur) found.set(key(cur), cur);
        }
        this.collected = null;
        const latest = [...found.values()];
        this.progress = { phase: 'triaging', round: this.progress.round, found: latest.length, done: 0, total: latest.length };
        this.changed();
        const step = () => {
          this.progress = this.progress && { ...this.progress, done: Math.min(this.progress.total, this.progress.done + 1) };
          this.changed();
        };
        if (this.sinkBatch) await this.sinkBatch(latest, step).catch((e) => console.error('[resume]', e.message));
        else for (const i of latest) await this.sink(i).then(step, (e) => console.error('[resume]', e.message));
      } finally {
        this.collected = null;
        this.catchingUp = false;
        this.progress = undefined;
        this.changed();
      }
    })();
    return this.pollingState;
  }

  /** What every ingestor hands its updates to: held while paused, cleaned-up items skipped while catching up. */
  private deliver: InboundSink = async (item) => {
    if (this.paused) {
      this.held = [...this.held.filter((h) => !(h.source === item.source && h.externalId === item.externalId)), item];
      await this.save();
      this.changed();
      return;
    }
    if (this.collected) {
      if (this.cleaned(item)) await this.repo.audit('system', 'polling.skipped_cleaned', { source: item.source, externalId: item.externalId, title: item.title }).catch(() => undefined);
      else this.collected.push(item);
      return;
    }
    return this.sink(item);
  };

  /** An email thread cleaned up during the pause: deleted, or archived (unless its newest message is the PU's own). */
  private cleaned(item: InboundItem) {
    if (item.source !== 'gmail') return false;
    const st = item.data.gmail?.state;
    if (!st) return false;
    if (st.trash) return true;
    const last = item.data.messages?.[item.data.messages.length - 1];
    return !st.inbox && !last?.isFromPU;
  }

  /** A held update as it is now: null when it was cleaned up (email deleted or archived, Slack message deleted). */
  private async current(item: InboundItem): Promise<InboundItem | null> {
    if (this.world) return this.cleaned(item) ? null : item;
    if (item.source === 'gmail') {
      const g = (await this.api('email')) as GoogleWorkspace;
      const fresh = await g.getThread(item.externalId, item.eventId);
      return this.cleaned(fresh) ? null : fresh;
    }
    if (item.source === 'slack') {
      const sl = (await this.api('chat')) as SlackWorkspace;
      const [channel, threadTs] = item.externalId.split(':');
      const ts = item.eventId?.split(':')[1];
      const fresh = threadTs === 'dm' ? await sl.getDmConversation(channel, ts) : await sl.getThread(channel, threadTs, ts);
      if (ts && !(fresh.data.messages ?? []).some((m) => m.id === ts)) return null; // the message was deleted
      return fresh;
    }
    return item;
  }

  async restart() {
    for (const i of this.ingestors) await i.stop().catch(() => undefined);
    this.ingestors = [];
    this.jira = undefined;
    this.cache = {};
    if (this.world) {
      this.ingestors = this.world.ingestors(this.deliver);
    } else {
      const s = await this.settings.get();
      const tracked = async (source: string) => {
        const skipMuted = !!(await this.settings.get()).silencing?.skipPolling;
        const rows = await this.repo.db
          .selectFrom('items')
          .innerJoin('streams', 'streams.id', 'items.stream_id')
          .select(['items.external_id', 'items.data'])
          .where('streams.status', '=', 'open')
          .where('items.source', '=', source as any)
          .execute();
        // With "don't poll silenced items", a silenced thread is not looked at again until it is un-silenced.
        return rows.filter((r) => !(skipMuted && r.data.includes('"muted":true'))).map((r) => r.external_id);
      };
      if (s.google.enabled && s.google.mode === 'oauth' && s.google.oauth.refreshTokenId) {
        try {
          const g = (await this.api('email')) as GoogleWorkspace;
          this.ingestors.push(new GmailIngestor(g, s.google, this.repo, this.deliver, this.report('google')));
        } catch (e: any) {
          this.report('google')(false, e.message);
        }
      }
      if (s.slack.enabled && s.slack.mode === 'api' && s.slack.api.userTokenId) {
        try {
          const sl = (await this.api('chat')) as SlackWorkspace;
          const app = s.slack.api.appTokenId ? await this.secret(s.slack.api.appTokenId).catch(() => null) : null;
          this.ingestors.push(new SlackIngestor(sl, s.slack, app, this.repo, async () => new Set(await tracked('slack')), this.deliver, this.report('slack')));
        } catch (e: any) {
          this.report('slack')(false, e.message);
        }
      }
      if (s.atlassian.enabled && s.atlassian.mode === 'api' && s.atlassian.api.apiTokenId) {
        try {
          const at = (await this.api('tickets')) as AtlassianCloud;
          const keys = async () => [...(await tracked('jira')), ...(await tracked('jsm'))];
          this.jira = new JiraIngestor(at, s.atlassian, this.repo, keys, this.deliver, this.report('atlassian'));
          this.ingestors.push(this.jira);
        } catch (e: any) {
          this.report('atlassian')(false, e.message);
        }
      }
      for (const sys of ['google', 'slack', 'atlassian'] as const) {
        const x = s[sys];
        if (x.enabled && x.mode === 'mcp' && x.ingestion !== 'off' && this.mcpIngestorFactory) {
          this.ingestors.push(this.mcpIngestorFactory(sys, this.deliver, this.report(sys)));
        }
      }
    }
    // Every poll (on its timer, after a wake, from Sync now) checks first: nothing is fetched while paused.
    for (const i of this.ingestors) {
      const poll = i.pollOnce?.bind(i);
      if (poll) i.pollOnce = async () => (this.alive() ? poll() : undefined);
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
    clearInterval(this.ticker);
    for (const i of this.ingestors) await i.stop().catch(() => undefined);
  }
}
