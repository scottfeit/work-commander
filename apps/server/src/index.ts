import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { installGuard } from './auth/guard.js';
import { registerRoutes } from './api/routes.js';

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

  await app.hub.start(app.triage.sink);

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
