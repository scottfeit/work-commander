import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GENERAL_STREAM, type EnvironmentInfo, type SecretBackend, type Settings } from '@wc/shared';
import type { App } from '../app.js';
import { bus } from '../core/bus.js';
import { GOOGLE_SCOPES, oauthClient } from '../integrations/google.js';
import { McpConnection, isReadOnlyTool } from '../integrations/mcp.js';
import { AtlassianCloud } from '../integrations/atlassian.js';
import { SlackWorkspace } from '../integrations/slack.js';
import { DEFAULT_MAPPINGS, fetchJiraAssets, fetchWorkdayRaas, fetchWorkdayRest, mapRecords, parseFile } from '../orgchart/import.js';
import { notFound } from '../core/errors.js';
import { CREDENTIAL_LABELS } from '../secrets/store.js';

const sid = (id: string) => (id === GENERAL_STREAM || id === 'general' ? null : id);

/** Settings fields that point at a credential, keyed by credential id. */
function credentialPointer(id: string, s: Settings): Partial<Settings> | null {
  switch (id) {
    case 'anthropic.apiKey':
      return { claude: { ...s.claude, apiKeyId: id } };
    case 'google.oauth.clientSecret':
      return { google: { ...s.google, oauth: { ...s.google.oauth, clientSecretId: id } } };
    case 'google.oauth.refreshToken':
      return { google: { ...s.google, oauth: { ...s.google.oauth, refreshTokenId: id } } };
    case 'slack.userToken':
      return { slack: { ...s.slack, api: { ...s.slack.api, userTokenId: id } } };
    case 'slack.appToken':
      return { slack: { ...s.slack, api: { ...s.slack.api, appTokenId: id } } };
    case 'atlassian.apiToken':
      return { atlassian: { ...s.atlassian, api: { ...s.atlassian.api, apiTokenId: id } } };
    case 'atlassian.webhookSecret':
      return { atlassian: { ...s.atlassian, api: { ...s.atlassian.api, webhookSecretId: id } } };
    case 'onepassword.serviceAccountToken':
      return { onepassword: { ...s.onepassword, serviceAccountTokenId: id } };
    case 'onepassword.connectToken':
      return { onepassword: { ...s.onepassword, connect: { url: s.onepassword.connect?.url ?? '', tokenId: id } } };
    case 'workday.clientSecret':
      return s.orgChart.type === 'workday-rest' ? { orgChart: { ...s.orgChart, clientSecretId: id } } : null;
    case 'workday.refreshToken':
      return s.orgChart.type === 'workday-rest' ? { orgChart: { ...s.orgChart, refreshTokenId: id } } : null;
    case 'workday.raasPassword':
      return s.orgChart.type === 'workday-raas' ? { orgChart: { ...s.orgChart, passwordId: id } } : null;
  }
  return null;
}

export async function registerRoutes(f: FastifyInstance, app: App) {
  const { repo, settings, secrets, hub, executor, runner, cfg } = app;

  f.get('/healthz', async () => ({ ok: true }));

  f.get('/api/env', async (): Promise<EnvironmentInfo> => ({
    hosting: cfg.hosting,
    demoMode: cfg.demoMode,
    availableBackends: secrets.availableBackends(),
    availableProviders: cfg.hosting === 'local' ? ['claude-code-login', 'vertex', 'api-key'] : ['vertex', 'api-key'],
    publicUrl: cfg.publicUrl,
    version: cfg.version,
  }));

  // ---------- live events ----------
  // Changes whenever the server process restarts, so open pages know their state is stale.
  const bootId = Math.random().toString(36).slice(2);
  f.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write(`event: boot\ndata: ${bootId}\n\n`);
    const off = bus.subscribe((e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      off();
      clearInterval(ping);
    });
  });

  // ---------- streams ----------
  f.get('/api/streams', async (req) => repo.listStreams((req.query as any).includeClosed === '1'));
  f.post('/api/streams', async (req) => {
    const b = z.object({ title: z.string().min(1), summary: z.string().default('') }).parse(req.body);
    return repo.createStream(b);
  });
  f.patch('/api/streams/:id', async (req) => {
    const id = (req.params as any).id;
    const b = z
      .object({
        title: z.string().optional(),
        summary: z.string().optional(),
        status: z.enum(['open', 'closed']).optional(),
        labels: z.array(z.string()).optional(),
        unread: z.boolean().optional(),
        ticketTarget: z.object({ flavor: z.enum(['jsm', 'jira']), projectKey: z.string(), typeId: z.string(), serviceDeskId: z.string().optional() }).nullable().optional(),
      })
      .parse(req.body);
    await repo.updateStream(id, b);
    return repo.getStream(id);
  });
  // 404 for streams that do not exist (the general stream is virtual and always exists).
  const existing = async (raw: string) => {
    const id = sid(raw);
    if (id !== null && !(await repo.getStream(id))) throw notFound('Work stream');
    return id;
  };
  f.get('/api/streams/:id/items', async (req) => repo.listItems((await existing((req.params as any).id)) ?? ''));
  f.get('/api/streams/:id/grants', async (req) => app.grants.list((req.params as any).id));
  f.post('/api/grants/:id/revoke', async (req) => {
    await app.grants.revoke((req.params as any).id);
    return { ok: true };
  });

  // ---------- chat ----------
  f.get('/api/streams/:id/chat', async (req) => repo.listChat(await existing((req.params as any).id)));
  f.post('/api/streams/:id/chat', async (req, reply) => {
    const streamId = await existing((req.params as any).id);
    const b = z.object({ text: z.string().min(1), selectedItemId: z.string().optional(), answersQuestionId: z.string().optional() }).parse(req.body);
    await repo.addChat({ streamId, role: 'user', content: b.text, meta: { selectedItemId: b.selectedItemId } });
    if (b.answersQuestionId) {
      const q = await repo.getChat(b.answersQuestionId);
      if (q) await repo.updateChatMeta(q.id, { ...q.meta, question: { ...q.meta.question, answered: true } });
    }
    void runner.run({ streamId, prompt: b.text, origin: 'user', selectedItemId: b.selectedItemId });
    return reply.code(202).send({ ok: true });
  });
  f.post('/api/chat/:id/suggestion', async (req) => {
    const m = await repo.getChat((req.params as any).id);
    if (!m?.meta.suggestion) throw new Error('Not a suggestion');
    const accept = z.object({ accept: z.boolean() }).parse(req.body).accept;
    await repo.updateChatMeta(m.id, { ...m.meta, suggestion: { ...m.meta.suggestion, status: accept ? 'accepted' : 'dismissed' } });
    if (accept) void runner.run({ streamId: m.streamId, origin: 'user', prompt: `The PU accepted your offer: ${m.meta.suggestion.instruction}` });
    return { ok: true };
  });

  // ---------- proposals (draft pane) ----------
  f.get('/api/proposals', async (req) => {
    const q = req.query as any;
    return repo.listProposals({
      streamId: q.streamId === undefined ? undefined : sid(q.streamId),
      status: q.status ? String(q.status).split(',') as any : undefined,
    });
  });
  f.patch('/api/proposals/:id', async (req) => executor.edit((req.params as any).id, z.object({ payload: z.record(z.string(), z.unknown()) }).parse(req.body).payload));
  f.post('/api/proposals/:id/approve', async (req) => {
    const b = z.object({ payload: z.record(z.string(), z.unknown()).optional() }).parse(req.body ?? {});
    return executor.approve((req.params as any).id, b.payload);
  });
  f.post('/api/proposals/:id/reject', async (req) => {
    const b = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    await executor.reject((req.params as any).id, b.reason);
    return { ok: true };
  });

  // ---------- settings & credentials ----------
  f.get('/api/settings', async () => settings.get());
  f.put('/api/settings', async (req) => {
    const patch = req.body as Partial<Settings>;
    if (patch.claude?.provider === 'claude-code-login' && cfg.hosting !== 'local') throw new Error('Claude Code login is only available for local hosting');
    return settings.update(patch);
  });
  f.get('/api/credentials', async () => ({ items: await secrets.list(), labels: CREDENTIAL_LABELS }));
  f.put('/api/credentials/:id', async (req) => {
    const id = (req.params as any).id as string;
    const b = z.object({ value: z.string().min(1), backend: z.enum(['keychain', 'gcp-secret-manager', 'onepassword']), label: z.string().optional() }).parse(req.body);
    await secrets.set(id, b.value, b.backend as SecretBackend, b.label);
    const ptr = credentialPointer(id, await settings.get());
    if (ptr) await settings.update(ptr);
    return { ok: true };
  });
  f.post('/api/credentials/:id/link', async (req) => {
    const id = (req.params as any).id as string;
    const b = z.object({ ref: z.string().min(1), backend: z.enum(['keychain', 'gcp-secret-manager', 'onepassword']), label: z.string().optional() }).parse(req.body);
    await secrets.link(id, b.backend, b.ref, b.label);
    await secrets.get(id); // verify it resolves
    const ptr = credentialPointer(id, await settings.get());
    if (ptr) await settings.update(ptr);
    return { ok: true };
  });
  f.delete('/api/credentials/:id', async (req) => {
    await secrets.remove((req.params as any).id);
    return { ok: true };
  });

  // ---------- Claude ----------
  f.post('/api/claude/test', async () => ({ reply: await app.backend.test() }));

  // ---------- Google OAuth ----------
  f.get('/api/oauth/google/start', async (_req, reply) => {
    const s = await settings.get();
    if (!s.google.oauth.clientId || !s.google.oauth.clientSecretId) throw new Error('Save the OAuth client id and secret first');
    const c = oauthClient(s.google.oauth.clientId, await secrets.get(s.google.oauth.clientSecretId), hub.redirectUri);
    const state = Math.random().toString(36).slice(2);
    await repo.setSync('google.oauthState', state);
    return reply.redirect(c.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: GOOGLE_SCOPES, state, login_hint: s.pu.email || undefined }));
  });
  f.get('/api/oauth/google/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error) return reply.redirect(`/settings?google=${encodeURIComponent(q.error)}`);
    if (!q.state || q.state !== (await repo.getSync('google.oauthState'))) return reply.code(400).send('Invalid OAuth state');
    const s = await settings.get();
    const c = oauthClient(s.google.oauth.clientId, await secrets.get(s.google.oauth.clientSecretId!), hub.redirectUri);
    const { tokens } = await c.getToken(q.code!);
    if (!tokens.refresh_token) return reply.redirect('/settings?google=no_refresh_token');
    const backend = (await secrets.list()).find((x) => x.id === 'google.oauth.clientSecret')?.backend ?? s.secrets.defaultBackend;
    await secrets.set('google.oauth.refreshToken', tokens.refresh_token, backend);
    const info = tokens.id_token ? await c.verifyIdToken({ idToken: tokens.id_token, audience: s.google.oauth.clientId }) : null;
    await settings.update({ google: { ...s.google, enabled: true, mode: 'oauth', oauth: { ...s.google.oauth, refreshTokenId: 'google.oauth.refreshToken', connectedEmail: info?.getPayload()?.email } } });
    return reply.redirect('/settings?google=connected');
  });

  // ---------- integrations ----------
  f.get('/api/integrations/status', async () => hub.status);
  f.post('/api/integrations/sync', async () => {
    await hub.pollAll();
    return hub.status;
  });
  f.post('/api/integrations/:system/test', async (req) => {
    const system = (req.params as any).system as 'google' | 'slack' | 'atlassian';
    const s = await settings.get();
    const x = s[system];
    if (x.mode === 'mcp') {
      const conn = await McpConnection.open(x.mcp!, (id) => secrets.get(id));
      try {
        const tools = await conn.listTools();
        return { ok: true, tools: tools.map((t) => ({ name: t.name, readOnly: isReadOnlyTool(t.name, x.mcp!, t.annotations) })) };
      } finally {
        await conn.close();
      }
    }
    if (system === 'google') {
      const p = await (await hub.api('email')).search('in:inbox', 1);
      return { ok: true, detail: `Gmail reachable (${p.length} recent thread)` };
    }
    if (system === 'slack') {
      const sl = new SlackWorkspace(await secrets.get(s.slack.api.userTokenId!));
      const uid = await sl.selfUserId();
      await settings.update({ pu: { ...s.pu, slackUserId: uid } });
      return { ok: true, detail: `Connected as Slack user ${uid}` };
    }
    const at = new AtlassianCloud(s.atlassian.api.siteUrl, s.atlassian.api.email, await secrets.get(s.atlassian.api.apiTokenId!));
    const me = await at.myself();
    await settings.update({ pu: { ...s.pu, atlassianAccountId: me.accountId } });
    return { ok: true, detail: `Connected as ${me.displayName}` };
  });
  f.get('/api/atlassian/servicedesks', async () => (await hub.api('tickets')).listServiceDesks());
  f.get('/api/atlassian/requesttypes', async (req) => (await hub.api('tickets')).listRequestTypes(String((req.query as any).desk)));
  f.get('/api/onepassword/items', async (req) => app.grants.listItems((req.query as any).q));

  // ---------- org chart ----------
  f.get('/api/people', async () => repo.listPeople());
  f.get('/api/orgchart/default-mapping/:type', async (req) => DEFAULT_MAPPINGS[(req.params as any).type as keyof typeof DEFAULT_MAPPINGS] ?? null);
  f.post('/api/orgchart/import', async (req) => {
    const s = await settings.get();
    const oc = s.orgChart;
    const preview = (req.query as any).preview === '1';
    let records: any[];
    if (oc.type === 'file') {
      const file = await (req as any).file();
      if (!file) throw new Error('Upload a CSV or XLSX file');
      records = await parseFile(file.filename, await file.toBuffer());
    } else if (oc.type === 'workday-rest') records = await fetchWorkdayRest(oc, (id) => secrets.get(id));
    else if (oc.type === 'workday-raas') records = await fetchWorkdayRaas(oc, (id) => secrets.get(id));
    else if (oc.type === 'jira-assets') {
      if (!s.atlassian.api.apiTokenId) throw new Error('Jira Assets uses the Atlassian API token; add it under Atlassian');
      records = await fetchJiraAssets(oc, { email: s.atlassian.api.email, token: await secrets.get(s.atlassian.api.apiTokenId) });
    } else throw new Error('Choose an org chart source first');
    const people = mapRecords(records, oc.mapping);
    if (preview) return { fields: Object.keys(records[0] ?? {}), sample: records.slice(0, 3), mapped: people.slice(0, 5), total: records.length, mappedTotal: people.length };
    const source = oc.type === 'file' ? 'file' : oc.type;
    await repo.replacePeople(source, people);
    return { imported: people.length, skipped: records.length - people.length };
  });
  f.post('/api/people', async (req) => {
    const b = z.object({ name: z.string(), email: z.string(), title: z.string().optional(), department: z.string().optional(), managerEmail: z.string().optional() }).parse(req.body);
    const existing = (await repo.listPeople()).filter((p) => p.source === 'manual').map(({ id: _id, source: _s, ...rest }) => rest);
    await repo.replacePeople('manual', [...existing.filter((p) => p.email !== b.email.toLowerCase()), b]);
    return { ok: true };
  });

  // ---------- webhooks ----------
  f.post('/api/webhooks/jira', async (req, reply) => {
    const s = await settings.get();
    const expected = s.atlassian.api.webhookSecretId ? await secrets.get(s.atlassian.api.webhookSecretId) : null;
    const given = (req.query as any).secret ?? req.headers['x-wc-secret'];
    if (!expected || given !== expected) return reply.code(401).send({ error: 'bad secret' });
    void hub.jiraWebhook(req.body).catch((e) => console.error('[jira webhook]', e.message));
    return { ok: true };
  });

  f.get('/api/audit', async () => repo.db.selectFrom('audit_log').selectAll().orderBy('id', 'desc').limit(200).execute());
}
