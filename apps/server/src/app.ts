import type { AppConfig } from './config.js';
import { openDatabase, type Database } from './db/index.js';
import { SettingsStore } from './core/settings.js';
import { Repo } from './core/repo.js';
import { offerAddedChat } from './core/chatHint.js';
import { SecretStore } from './secrets/store.js';
import { IntegrationHub, type WorldOverride } from './integrations/hub.js';
import { GrantService } from './onepassword/grants.js';
import type { OnePasswordClient } from './onepassword/client.js';
import { Executor } from './core/executor.js';
import { ClaudeAgentBackend, type AgentBackend } from './agent/backend.js';
import { StreamAgentRunner } from './agent/runner.js';
import { TriagePipeline } from './agent/triage.js';
import { McpPollIngestor } from './agent/mcpIngest.js';
import { runInternalTool, type ToolDeps } from './agent/tools.js';
import { AttachmentStore } from './core/attachments.js';
import { McpOAuth, setMcpOAuth } from './integrations/mcpOAuth.js';
import { UsageLog } from './core/usage.js';
import { LayaManager } from './laya/manager.js';
import { LayaService } from './laya/service.js';

export interface App {
  cfg: AppConfig;
  db: Database;
  settings: SettingsStore;
  repo: Repo;
  secrets: SecretStore;
  hub: IntegrationHub;
  grants: GrantService;
  executor: Executor;
  backend: AgentBackend;
  runner: StreamAgentRunner;
  triage: TriagePipeline;
  attachments: AttachmentStore;
  mcpOAuth: McpOAuth;
  usage: UsageLog;
  laya: LayaService;
}

export interface AppOverrides {
  backend?: (app: Omit<App, 'backend' | 'runner' | 'triage' | 'laya'>) => AgentBackend;
  world?: (repo: Repo) => WorldOverride;
  onePassword?: () => Promise<OnePasswordClient>;
  grantFetch?: typeof fetch;
}

/** Composition root: wires storage, secrets, integrations, executor and agents together. */
export async function createApp(cfg: AppConfig, o: AppOverrides = {}): Promise<App> {
  const { db } = await openDatabase(cfg.databaseUrl);
  const settings = new SettingsStore(db);
  const get = () => settings.get();
  const repo = new Repo(db);
  const secrets = new SecretStore(db, cfg, get);
  const attachments = new AttachmentStore(db, repo);
  const mcpOAuth = new McpOAuth({
    secrets,
    sync: { get: (k) => repo.getSync(k), set: (k, v) => repo.setSync(k, v) },
    defaultBackend: async () => (await settings.get()).secrets.defaultBackend,
    redirectUri: () => `${cfg.publicUrl}/api/oauth/mcp/callback`,
  });
  setMcpOAuth(mcpOAuth);
  const hub = new IntegrationHub(cfg, settings, secrets, repo, o.world?.(repo));
  const sync = { get: (k: string) => repo.getSync(k), set: (k: string, v: string) => repo.setSync(k, v) };
  const usage = new UsageLog(db, {
    settings: get,
    sync,
    emailSelf: async (subject, body) => {
      const s = await settings.get();
      if (!s.pu.email) throw new Error('your email address is not set in Settings');
      const mail = (await hub.api('email')) as { send(i: { to: string[]; cc: string[]; subject: string; body: string }): Promise<unknown> };
      await mail.send({ to: [s.pu.email], cc: [], subject, body });
      await repo.audit('system', 'usage.alert.emailed', { to: s.pu.email });
    },
    log: (m) => console.error('[usage]', m),
  });
  const grants = new GrantService(repo, secrets, get, o.onePassword, o.grantFetch);
  let toolDeps: ToolDeps;
  const executor = new Executor(repo, hub, grants, get, secrets, () => (name, args, ctx) => runInternalTool(name, args, ctx, toolDeps), attachments, (p) => settings.update(p));
  toolDeps = { repo, hub, grants, executor, settings: get, attachments, secret: (id) => secrets.get(id), structured: (i) => backend.structured(i), canHandoff: cfg.hosting === 'local' };
  const partial = { cfg, db, settings, repo, secrets, hub, grants, executor, attachments, mcpOAuth, usage };
  const backend = o.backend ? o.backend(partial) : new ClaudeAgentBackend(cfg, get, secrets, usage, sync);
  const runner = new StreamAgentRunner(repo, backend, hub, executor, secrets, get, toolDeps, usage);
  let laya: LayaService;
  const layaManager = new LayaManager(cfg.dataDir, () => laya?.notify());
  laya = new LayaService(db, repo, layaManager, get, cfg.hosting === 'local');
  const triage = new TriagePipeline(repo, backend, runner, get, cfg.hosting === 'local', usage, laya);
  triage.onAddedToChat = (a) => offerAddedChat({ repo, settings: get, secret: (id) => secrets.get(id), structured: (i) => backend.structured(i) }, a);
  hub.mcpIngestorFactory = (system, sink, report) => new McpPollIngestor(system, backend, get, secrets, repo, sink, report);
  await executor.recoverInterrupted();
  return { ...partial, backend, runner, triage, laya };
}
