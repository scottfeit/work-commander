import { test, expect, freshApp, api } from './helpers';

freshApp();

test('approving dependent drafts at the same instant executes both, in order', async () => {
  const [ticket, mail] = await api.waitPending(['ticket_create', 'email_reply']);
  const res = await Promise.all([api.post(`/api/proposals/${mail.id}/approve`), api.post(`/api/proposals/${ticket.id}/approve`)]);
  expect(res.map((r) => r.status)).toEqual([200, 200]);
  await api.waitStatus(ticket.id, 'executed');
  const sent = await api.waitStatus(mail.id, 'executed');
  expect(JSON.stringify(sent.payload)).not.toContain('{{');
});

test('API errors are clean 4xx JSON, never 500s', async () => {
  const cases: [string, string, unknown][] = [
    ['POST', '/api/proposals/nope/approve', {}],
    ['POST', '/api/proposals/nope/reject', {}],
    ['PATCH', '/api/proposals/nope', { payload: {} }],
    ['PATCH', '/api/proposals/nope', { payload: 'not-an-object' }],
    ['POST', '/api/streams', { title: '' }],
    ['POST', '/api/streams', {}],
    ['POST', '/api/streams/nope/chat', { text: '' }],
    ['GET', '/api/streams/nope/items', undefined],
    ['GET', '/api/does-not-exist', undefined],
  ];
  for (const [method, path, body] of cases) {
    const r = await api.call(method, path, body);
    expect(r.status, `${method} ${path} -> ${r.status} ${r.text.slice(0, 120)}`).toBeLessThan(500);
    expect(r.status, `${method} ${path} should be rejected`).toBeGreaterThanOrEqual(400);
  }
});

test('re-approving, editing or rejecting a finished draft is refused', async () => {
  // Self-contained: a failure elsewhere in this file restarts the worker (and the app), so don't assume earlier state.
  const [pending] = await api.waitPending(['ticket_create']).catch(() => []);
  if (pending) await api.post(`/api/proposals/${pending.id}/approve`);
  const ticket = (await api.proposals()).find((p) => p.kind === 'ticket_create')!;
  await api.waitStatus(ticket.id, 'executed');
  for (const [m, p, b] of [
    ['POST', `/api/proposals/${ticket.id}/approve`, {}],
    ['POST', `/api/proposals/${ticket.id}/reject`, {}],
    ['PATCH', `/api/proposals/${ticket.id}`, { payload: { summary: 'tampered' } }],
  ] as const) {
    const r = await api.call(m, p, b);
    expect(r.status, `${m} ${p} -> ${r.status}`).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  }
  const after = (await api.proposals()).find((p) => p.id === ticket.id)!;
  expect(after.payload.summary).not.toBe('tampered');
});

test('malformed JSON and oversized bodies are rejected without crashing the server', async () => {
  const bad = await fetch('http://127.0.0.1:8887/api/streams', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  expect(bad.status).toBeGreaterThanOrEqual(400);
  expect(bad.status).toBeLessThan(500);
  // The server may answer 413 or cut the connection while we are still uploading; both are a rejection.
  const huge = await fetch('http://127.0.0.1:8887/api/streams', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x'.repeat(6 * 1024 * 1024) }) }).catch(() => null);
  if (huge) expect(huge.status).toBeGreaterThanOrEqual(400);
  expect((await fetch('http://127.0.0.1:8887/healthz')).ok).toBe(true);
});
