import type { Settings } from '@wc/shared';
import type { Database } from '../db/index.js';
import { pj } from '../db/index.js';

const DEFAULT_READ_ONLY = ['(^|_)(get|list|search|fetch|read|lookup|find|query|describe)'];

export function defaultSettings(): Settings {
  return {
    pu: { name: '', email: '', orgFunction: '', aliases: [], relevanceNotes: '' },
    claude: {
      provider: 'claude-code-login',
      model: 'sonnet',
      vertex: { projectId: '', region: 'global' },
      allowWebResearch: false,
      autoDraft: true,
      reopenClosedWithinDays: 14,
      maxTurns: 30,
    },
    secrets: { defaultBackend: 'keychain', gcpProjectId: '' },
    google: {
      enabled: false,
      mode: 'oauth',
      oauth: { clientId: '', gmailQuery: 'in:inbox -category:promotions -category:social' },
      mcp: { transport: 'http', readOnlyToolPatterns: DEFAULT_READ_ONLY },
      ingestion: 'polling',
      pollSeconds: 60,
      policy: { read: 'auto', write: 'approve' },
    },
    slack: {
      enabled: false,
      mode: 'api',
      api: {},
      mcp: { transport: 'http', url: 'https://mcp.slack.com/mcp', readOnlyToolPatterns: DEFAULT_READ_ONLY },
      watchedChannels: '',
      ingestion: 'realtime',
      pollSeconds: 60,
      policy: { read: 'auto', write: 'approve' },
    },
    atlassian: {
      enabled: false,
      mode: 'api',
      api: { siteUrl: '', email: '' },
      mcp: { transport: 'http', readOnlyToolPatterns: DEFAULT_READ_ONLY },
      jql: '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser())',
      ingestion: 'polling',
      pollSeconds: 120,
      policy: { read: 'auto', write: 'approve' },
    },
    onepassword: {
      enabled: false,
      mode: 'service-account',
      accessVault: '',
      secretsVault: '',
      grantTtlMinutes: 60,
      policy: { read: 'approve', write: 'approve' },
    },
    orgChart: { type: 'none' },
    ui: { showClosedByDefault: false, recentTabFirst: false, openTab: 'overview' },
    backup: { enabled: false, folder: '', everyHours: 24, keep: 14 },
    setupComplete: false,
  };
}

/** Deep-merge stored settings onto defaults so new fields get sensible values after upgrades. */
function merge<T>(base: T, over: unknown): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (over ?? base) as T;
  if (typeof over !== 'object' || over === null) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b !== undefined && typeof b === 'object' && b !== null && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v) ? merge(b, v) : v;
  }
  return out as T;
}

export class SettingsStore {
  private cache: Settings | null = null;
  private listeners: ((s: Settings, prev: Settings) => void)[] = [];
  constructor(private db: Database) {}

  async get(): Promise<Settings> {
    if (this.cache) return this.cache;
    const row = await this.db.selectFrom('settings').selectAll().where('key', '=', 'settings').executeTakeFirst();
    this.cache = merge(defaultSettings(), pj(row?.value, {}));
    return this.cache;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const prev = await this.get();
    const next = merge(prev, patch);
    const value = JSON.stringify(next);
    await this.db
      .insertInto('settings')
      .values({ key: 'settings', value })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
      .execute();
    this.cache = next;
    for (const l of this.listeners) l(next, prev);
    return next;
  }

  onChange(fn: (s: Settings, prev: Settings) => void) {
    this.listeners.push(fn);
  }
}
