import { test, expect, freshApp, api, rawRequest, API_PORT } from './helpers';

freshApp();

const bad = (host: string) => rawRequest({ path: '/api/settings', headers: { host } });

test('requests addressed to a foreign Host are refused (DNS-rebinding protection)', async () => {
  for (const h of ['evil.example', `evil.example:${API_PORT}`, '169.254.169.254', 'localhost.evil.example']) {
    const r = await bad(h);
    expect(r.status, `Host: ${h}`).toBe(403);
  }
  expect((await bad(`localhost:${API_PORT}`)).status).toBe(200);
  expect((await bad(`127.0.0.1:${API_PORT}`)).status).toBe(200);
});

test('cross-origin state-changing requests are refused', async () => {
  for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'null', 'file://', 'not a url', '']) {
    const r = await rawRequest({ method: 'POST', path: '/api/streams', headers: { host: `localhost:${API_PORT}`, origin, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'csrf' }) });
    expect(r.status, `Origin: "${origin}" -> ${r.status} ${r.body.slice(0, 100)}`).toBeGreaterThanOrEqual(400);
    expect(r.status, `Origin: "${origin}" must not crash the handler`).toBeLessThan(500);
  }
  expect((await api.streams()).some((s: any) => s.title === 'csrf')).toBe(false);
});

test('GET /api/settings and /api/credentials never contain secret values', async () => {
  const dump = JSON.stringify([(await api.get('/api/settings')).json, (await api.get('/api/credentials')).json]);
  expect(dump).not.toMatch(/sk-ant-[A-Za-z0-9_-]{20,}|xox[bpa]-[0-9A-Za-z-]{10,}|xapp-[0-9A-Za-z-]{10,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN|"(apiKey|clientSecret|refreshToken|token|password)"\s*:\s*"[^"]{8,}"/);
  expect(dump).not.toContain('demo-secret-token'); // the demo 1Password secret
});

test('the demo 1Password secret never reaches the API or chat history', async () => {
  const [ticket, mail] = await api.waitPending(['ticket_create', 'email_reply']);
  await api.post(`/api/proposals/${ticket.id}/approve`);
  await api.waitStatus(mail.id, 'pending').catch(() => undefined);
  const all = JSON.stringify([(await api.get('/api/audit')).json, (await api.get('/api/proposals')).json]);
  expect(all).not.toContain('demo-secret-token');
});

test('server errors do not leak stack traces or file paths', async () => {
  const r = await api.call('POST', '/api/streams', { title: 12345 });
  expect(r.text).not.toMatch(/\bat .*\(.*:\d+:\d+\)|\/home\/|\/Users\/|node_modules/);
});

test('basic hardening headers are present on the app and API', async () => {
  const r = await rawRequest({ path: '/api/env', headers: { host: `localhost:${API_PORT}` } });
  expect.soft(r.headers['x-content-type-options'], 'X-Content-Type-Options: nosniff').toBe('nosniff');
  expect.soft(r.headers['x-frame-options'] ?? r.headers['content-security-policy'], 'clickjacking protection (X-Frame-Options or CSP frame-ancestors)').toBeTruthy();
});

test('path traversal via the static file route is blocked', async () => {
  for (const p of ['/../package.json', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc/passwd']) {
    const r = await rawRequest({ path: p, headers: { host: `localhost:${API_PORT}` } });
    expect(r.body, p).not.toMatch(/root:.*:0:0|"workspaces"/);
  }
});
