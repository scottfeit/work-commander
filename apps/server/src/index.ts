import { claudeCodeUsage } from './core/claudeCodeUsage.js';
import { MeetingWatcher } from './core/meetings.js';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { installGuard } from './auth/guard.js';
import { registerRoutes } from './api/routes.js';
import { HandoffWatcher, RESULT_FILE, handoffResultPrompt, reportHasDraft } from './core/handoff.js';
import { bus } from './core/bus.js';
import { OrgChartRefresher } from './orgchart/refresh.js';
import { attachDriveFile, googleFileLinks } from './core/docs.js';
import { BackupScheduler } from './core/backup.js';
import { ReminderScheduler } from './core/reminders.js';

async function main() {
  const cfg = loadConfig();

  if (process.env.WC_ROLE === 'webhook-relay') return relay(cfg.port);

  // The demo's fake systems live in memory, so its saved database must not outlive the process
  // (a stale "already seeded" flag would leave streams pointing at threads that no longer exist).
  if (cfg.demoMode && !process.env.WC_DEMO_KEEP && cfg.dataDir.endsWith('.work-commander-demo')) {
    fs.rmSync(cfg.dataDir, { recursive: true, force: true });
  }

  const overrides = cfg.demoMode ? (await import('./demo/world.js')).demoOverrides() : {};
  const app = await createApp(cfg, overrides);
  if (cfg.demoMode) await (await import('./demo/world.js')).seedDemo(app);

  const f = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 5 * 1024 * 1024 });
  await f.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  // Basic hardening headers on every response (the dashboard must not be frameable or sniffed).
  f.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    reply.header('Referrer-Policy', 'no-referrer');
  });
  installGuard(f, cfg, app.settings);
  f.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = (err as any).statusCode && (err as any).statusCode < 500 ? (err as any).statusCode : err.name === 'ZodError' ? 400 : 500;
    reply.code(status).send({ error: err.message });
  });
  await registerRoutes(f, app);

  if (fs.existsSync(cfg.webDist)) {
    await f.register(fastifyStatic, { root: cfg.webDist, wildcard: false });
    f.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html')));
  }

  await app.repo.mergeAllChannelItems().then((n) => n && f.log.info(`folded ${n} Slack channel message item(s) into their discussions`)).catch((e) => f.log.warn(`channel merge: ${e.message}`));
  await app.repo.mergeSlackDmItems().then((n) => n && f.log.info(`merged ${n} duplicate Slack DM item(s)`)).catch((e) => f.log.warn(`DM merge: ${e.message}`));
  await app.repo.fillSlackUrls().then((n) => n && f.log.info(`added an Open-in-Slack link to ${n} Slack conversation item(s)`)).catch((e) => f.log.warn(`slack links: ${e.message}`));
  await app.hub.start(app.triage.sink, app.triage.sinkBatch);

  // Claude Code hand-offs: bring RESULT.md back into the stream automatically (local only: the folders live on this machine).
  if (cfg.hosting === 'local') {
    const watcher = new HandoffWatcher(
      app.repo,
      async (h, report) => {
        await app.repo.addChat({ streamId: h.streamId, role: 'system', content: `Claude Code finished: results from ${h.folder}/${RESULT_FILE}` });
        await app.repo.updateStream(h.streamId, { unread: true, touch: true, pending: false });
        bus.publish({ type: 'notify', streamId: h.streamId, title: 'Claude Code finished', body: 'Results are back in the work stream.' });
        // Claude Code's own token usage for this hand-off (from its transcripts), counted once, in the stream's usage.
        await recordClaudeCodeUsage(app, h).catch((e) => f.log.warn(`Claude Code usage: ${e.message}`));
        // Google Docs/Sheets/Slides it reports having edited become work items in this stream (the same file may be in several streams).
        const docs = await app.hub.api('docs').catch(() => null);
        for (const link of googleFileLinks(report)) await attachDriveFile(app.repo, docs, h.streamId, link).catch((e) => f.log.warn(`attach ${link.id}: ${e.message}`));
        void app.runner.run({
          streamId: h.streamId,
          origin: 'system',
          purpose: 'handoff',
          allowDrafts: reportHasDraft(report), // a draft Claude Code wrote reaches the Drafts pane even when automatic drafts are off
          prompt: handoffResultPrompt(h.folder, report),
        });
      },
      (m) => f.log.warn(m),
    );
    await watcher.start();
  }

  // Laya (local triage model): run it while it is chosen and installed; stop it when switched back to Claude.
  if (cfg.hosting === 'local') {
    const syncLaya = async () => {
      const on = (await app.laya.active()) && app.laya.installed;
      if (on) await app.laya.manager.ensure().then(() => app.laya.trainWhenReady()).catch((e) => f.log.warn(`laya: ${e.message}`));
      else await app.laya.manager.stop();
    };
    void syncLaya();
    app.settings.onChange((s, prev) => {
      if (s.triage?.engine !== prev.triage?.engine) void syncLaya();
    });
    // The helper is a child process: make sure it never outlives the server.
    process.once('exit', () => void app.laya.manager.stop());
  }

  // Workday report as org chart source: re-pull it periodically (a failed pull leaves the org chart as it was).
  new OrgChartRefresher({ repo: app.repo, secrets: app.secrets, settings: () => app.settings.get() }, (m) => f.log.warn(m)).start();

  // Messages whose triage was cut short (restart, sleep) are judged now and every few minutes after.
  // (Not while polling is paused: nothing is triaged until Resume.)
  const recover = () => void (app.hub.isPaused ? Promise.resolve() : app.triage.recoverUnprocessed()).catch((e) => f.log.warn(`triage recovery: ${e.message}`));
  recover();
  setInterval(recover, 5 * 60_000).unref();

  // Scheduled database backups (local SQLite only), configured under Settings > Backup.
  new BackupScheduler({ repo: app.repo, settings: () => app.settings.get(), sqlite: cfg.databaseUrl.startsWith('sqlite:') }, (m) => f.log.warn(m)).start();

  // Calendar meetings: linked to the work streams they're about, briefed before and followed up after (Settings → Meetings).
  new MeetingWatcher(
    { repo: app.repo, backend: app.backend, settings: () => app.settings.get(), calendar: () => app.hub.api('calendar').catch(() => null), paused: () => app.hub.isPaused, run: (r) => app.runner.run(r) },
    (m) => f.log.warn(m),
  ).start();

  // Pending streams untouched for the configured days come back to the top as a Reminder, with a nudge drafted by Claude.
  new ReminderScheduler({ repo: app.repo, settings: () => app.settings.get(), run: (r) => app.runner.run(r) }, (m) => f.log.warn(m)).start();

  // On GCP, Jira webhooks arrive through the IAP-free relay service via Pub/Sub.
  if (process.env.WC_JIRA_SUBSCRIPTION) {
    const { PubSub } = await import('@google-cloud/pubsub');
    new PubSub().subscription(process.env.WC_JIRA_SUBSCRIPTION).on('message', (m) => {
      m.ack();
      void app.hub.jiraWebhook(JSON.parse(m.data.toString('utf8'))).catch((e) => f.log.warn(`jira relay: ${e.message}`));
    });
  }

  await f.listen({ port: cfg.port, host: cfg.host });
  f.log.info(`Work Commander on ${cfg.publicUrl} (hosting=${cfg.hosting}, auth=${cfg.authMode}${cfg.demoMode ? ', DEMO MODE' : ''})`);

  const shutdown = async () => {
    await app.laya.manager.stop();
    await app.hub.stop();
    await f.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Minimal public endpoint for Jira webhooks when the dashboard itself is behind IAP: validates
 * the shared secret and forwards the payload to Pub/Sub. It has no access to anything else.
 */
async function relay(port: number) {
  const { PubSub } = await import('@google-cloud/pubsub');
  const topic = new PubSub().topic(process.env.WC_JIRA_TOPIC!);
  const secret = process.env.WC_JIRA_WEBHOOK_SECRET;
  const f = Fastify({ logger: true });
  f.get('/healthz', async () => ({ ok: true }));
  f.post('/api/webhooks/jira', async (req, reply) => {
    const given = (req.query as any).secret ?? req.headers['x-wc-secret'];
    if (!secret || given !== secret) return reply.code(401).send({ error: 'bad secret' });
    await topic.publishMessage({ json: req.body });
    return { ok: true };
  });
  await f.listen({ port, host: '0.0.0.0' });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/** Add what Claude Code used on a hand-off (since it started, or since last counted) to the work stream's usage, by model. */
async function recordClaudeCodeUsage(app: Awaited<ReturnType<typeof createApp>>, h: { id: string; streamId: string; folder: string }) {
  const key = `handoff.ccUsage.${h.id}`;
  const row = (await app.repo.listHandoffs()).find((x) => x.id === h.id);
  const since = (await app.repo.getSync(key)) || row?.created_at;
  if (!since) return;
  const until = new Date().toISOString();
  for (const u of await claudeCodeUsage(h.folder, since, until)) {
    await app.usage.record({ kind: 'claudeCode', model: u.model, streamId: h.streamId, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, costUsd: u.costUsd, durationMs: 0, ok: true });
  }
  await app.repo.setSync(key, until);
}

