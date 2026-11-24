import { TimerService } from './core/timers.js';
import { applyTransition, setAssignee } from './core/jiraActions.js';
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
import { ClaudeAgentBackend, providerEnv, type AgentBackend } from './agent/backend.js';
import { StreamAgentRunner } from './agent/runner.js';
import { TriagePipeline } from './agent/triage.js';
import { McpPollIngestor } from './agent/mcpIngest.js';
import { runInternalTool, type ToolDeps } from './agent/tools.js';
import { AttachmentStore } from './core/attachments.js';
import { McpOAuth, setMcpOAuth } from './integrations/mcpOAuth.js';
import { UsageLog } from './core/usage.js';
import { LayaManager } from './laya/manager.js';
import { LayaService } from './laya/service.js';
import { UndoLog } from './core/undo.js';
import { ClaudeCodeSessions } from './core/claudeCodeLive.js';
import { handoffResultPrompt, reportHasDraft } from './core/handoff.js';
import { slackMarkUnread } from './core/trashItem.js';
import { gmailThreadAction } from './core/gmailActions.js';

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
  /** System-wide Undo of the PU's last three actions. */
  undo: UndoLog;
  /** Claude Code running inside WC (Settings → Claude Code; off by default, local only). */
  claudeCode: ClaudeCodeSessions;
  timers: TimerService;
}

export interface AppOverrides {
  backend?: (app: Omit<App, 'backend' | 'runner' | 'triage' | 'laya' | 'undo' | 'claudeCode' | 'timers'>) => AgentBackend;
  /** For tests and the demo: stands in for the Agent SDK's query() in built-in Claude Code sessions. */
  claudeCodeQuery?: (args: any) => AsyncIterable<any>;
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
  const puEmails = async () => {
    const pu = (await get()).pu;
    return [pu.email, ...(pu.aliases ?? [])].filter(Boolean);
  };
  // New managers in the PU's lineage become VIPs when the org chart changes (once the Settings button turned that on).
  repo.onPeopleChanged = async () => repo.vips.syncLineage(await puEmails());
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
  const timers = new TimerService({ repo, backend, run: (r) => runner.run(r) });
  toolDeps.setTimer = (streamId, when, instruction, runId, suggest) => timers.create(streamId, when, instruction, runId, suggest);
  let laya: LayaService;
  const layaManager = new LayaManager(cfg.dataDir, () => laya?.notify());
  laya = new LayaService(db, repo, layaManager, get, cfg.hosting === 'local');
  const triage = new TriagePipeline(repo, backend, runner, get, cfg.hosting === 'local', usage, laya);
  triage.onAddedToChat = (a) => offerAddedChat({ repo, settings: get, secret: (id) => secrets.get(id), structured: (i) => backend.structured(i) }, a);
  hub.mcpIngestorFactory = (system, sink, report) => new McpPollIngestor(system, backend, get, secrets, repo, sink, report);
  await executor.recoverInterrupted();
  const undo = new UndoLog({
    repo,
    gmail: (itemId, action, opts) => gmailThreadAction({ repo, hub }, itemId, action, opts),
    jiraStatus: (itemId, status) => applyTransition({ repo, hub }, itemId, { to: status }),
    jiraAssign: (itemId, accountId) => setAssignee({ repo, hub }, itemId, { accountId }),
    layaChanged: () => laya.examplesRestored(),
    slackUnread: (itemId) => slackMarkUnread({ repo, hub }, itemId),
  });
  const claudeCode = new ClaudeCodeSessions({
    cfg,
    repo,
    settings: get,
    providerEnv: async () => providerEnv(await get(), cfg, secrets),
    recordUsage: (e) => usage.record({ kind: 'claudeCode', ...e }),
    onReport: (streamId, folder, report) =>
      void runner.run({ streamId, origin: 'system', purpose: 'handoff', allowDrafts: reportHasDraft(report), prompt: handoffResultPrompt(folder, report) }),
    query: o.claudeCodeQuery,
  });
  return { ...partial, backend, runner, triage, laya, undo, claudeCode, timers };
}
