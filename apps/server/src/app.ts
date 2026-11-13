import type { AppConfig } from './config.js';
import { openDatabase, type Database } from './db/index.js';
import { SettingsStore } from './core/settings.js';
import { Repo } from './core/repo.js';
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
}

export interface AppOverrides {
  backend?: (app: Omit<App, 'backend' | 'runner' | 'triage'>) => AgentBackend;
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
  const grants = new GrantService(repo, secrets, get, o.onePassword, o.grantFetch);
  let toolDeps: ToolDeps;
  const executor = new Executor(repo, hub, grants, get, secrets, () => (name, args, ctx) => runInternalTool(name, args, ctx, toolDeps), attachments, (p) => settings.update(p));
  toolDeps = { repo, hub, grants, executor, settings: get, attachments, secret: (id) => secrets.get(id), structured: (i) => backend.structured(i), canHandoff: cfg.hosting === 'local' };
  const partial = { cfg, db, settings, repo, secrets, hub, grants, executor, attachments, mcpOAuth };
  const backend = o.backend ? o.backend(partial) : new ClaudeAgentBackend(cfg, get, secrets);
  const runner = new StreamAgentRunner(repo, backend, hub, executor, secrets, get, toolDeps);
  const triage = new TriagePipeline(repo, backend, runner, get, cfg.hosting === 'local');
  hub.mcpIngestorFactory = (system, sink, report) => new McpPollIngestor(system, backend, get, secrets, repo, sink, report);
  await executor.recoverInterrupted();
  return { ...partial, backend, runner, triage };
}
