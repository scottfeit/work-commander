/**
 * Security, attacked from outside (complements 05-security.spec.ts): requests forged with raw HTTP (Host, Origin, paths),
 * script injection in the browser, internal-address requests, and the Claude Code guard.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, freshApp, api, rawRequest, stream, demoDataDir, API_PORT, WEB } from './helpers';

freshApp();

const local = { host: `localhost:${API_PORT}` };
const json = (origin?: string) => ({ ...local, 'content-type': 'application/json', ...(origin ? { origin } : {}) });

test.describe('network access', () => {
  test('a page served from another port on this machine cannot change anything', async () => {
    // KNOWN ISSUE (found by this suite): the Origin check compares host names only, so http://localhost:<any port> passes.
    test.fail();
    for (const origin of ['http://localhost:9999', 'http://127.0.0.1:3000', 'https://localhost', `http://localhost:${API_PORT + 1}`]) {
      const r = await rawRequest({ method: 'POST', path: '/api/streams', headers: json(origin), body: JSON.stringify({ title: `other-port ${origin}`, summary: '' }) });
      expect(r.status, `Origin ${origin}`).toBe(403);
    }
    expect((await api.streams()).some((s: any) => /^other-port/.test(s.title))).toBe(false);
  });

  test('no response lets another site read it (no CORS headers, preflights refused)', async () => {
    for (const p of ['/api/settings', '/api/streams', '/api/credentials', '/api/audit', '/api/env']) {
      const r = await rawRequest({ path: p, headers: { ...local, origin: 'https://evil.example' } });
      expect(r.headers['access-control-allow-origin'], p).toBeUndefined();
      expect(r.headers['access-control-allow-credentials'], p).toBeUndefined();
    }
    const pre = await rawRequest({ method: 'OPTIONS', path: '/api/proposals/x/approve', headers: { ...local, origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-wc-cc-token' } });
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    expect(pre.headers['access-control-allow-headers']).toBeUndefined();
  });

  test('the public webhook and health paths cannot be used to slip past the guard', async () => {
    for (const p of ['/api/webhooks/../settings', '/api/webhooks/%2e%2e/settings', '/api/webhooks/..%2fsettings', '/api/webhooks/x/../../streams', '/healthz/../api/settings', '/healthz?/../api/settings', '/api/webhooks%2f..%2fsettings']) {
      const r = await rawRequest({ path: p, headers: { host: 'evil.example' } });
      expect(r.body, p).not.toMatch(/"pu"|"secrets"|"claude"|"title"/);
      expect(r.status, p).not.toBe(200);
    }
  });

  test('the Jira webhook needs its secret', async () => {
    for (const q of ['', '?secret=', '?secret=wrong', '?secret[]=x']) {
      const r = await rawRequest({ method: 'POST', path: `/api/webhooks/jira${q}`, headers: json(), body: JSON.stringify({ webhookEvent: 'jira:issue_updated' }) });
      expect(r.status, q || '(none)').toBe(401);
    }
  });

  test('oversized requests are refused', async () => {
    const big = JSON.stringify({ title: 'x', summary: 'a'.repeat(6 * 1024 * 1024) });
    const r = await rawRequest({ method: 'POST', path: '/api/streams', headers: json(), body: big });
    expect(r.status).toBe(413);
  });

  test('attachment ids that try to climb out of their folder find nothing', async () => {
    for (const id of ['..%2f..%2f..%2fetc%2fpasswd', '%2e%2e', '..']) {
      const r = await rawRequest({ path: `/api/items/x/attachments/${id}`, headers: local });
      expect(r.status, id).toBeGreaterThanOrEqual(400);
      expect(r.body, id).not.toMatch(/root:.*:0:0/);
    }
    const d = await rawRequest({ path: '/api/attachments/..%2f..%2f..%2fetc%2fpasswd', headers: local });
    expect(d.body).not.toMatch(/root:.*:0:0/);
  });
});

test.describe('server-side requests', () => {
  test('a pasted link to an internal address is refused without any request being made', async () => {
    let hits = 0;
    const trap = http.createServer((_q, r) => (hits++, r.end('trap')));
    await new Promise<void>((ok) => trap.listen(0, '127.0.0.1', ok));
    const port = (trap.address() as any).port;
    const sid = (await api.post('/api/streams', { title: 'SSRF probe', summary: '' })).json.id;
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/archives/C0123456789/p1700000000000100`, 'http://169.254.169.254/latest/meta-data/', `http://127.0.0.1:${API_PORT}/api/settings`, 'file:///etc/passwd']) {
      const r = await api.post(`/api/streams/${sid}/items/from-url`, { url });
      expect(r.status, url).toBeGreaterThanOrEqual(400);
    }
    trap.close();
    expect(hits).toBe(0);
  });
});

test.describe('script injection in the page', () => {
  test('hostile titles, text, links, item URLs, attachment names and email HTML never run script', async ({ page }) => {
    const x = 'window.__xss=(window.__xss||0)+1';
    const sid = (await api.post('/api/streams', { title: `XSS <img src=x onerror="${x}">`, summary: `<script>${x}</script>` })).json.id;
    const msg = {
      id: 'x1',
      author: { name: `<img src=x onerror="${x}">`, email: 'a@b.c' },
      to: ['me@x.com'],
      text: `Hi <script>${x}</script> <img src=x onerror="${x}"> [click](javascript:${x}) <javascript:${x}|slack link> javascript:${x}`,
      at: new Date().toISOString(),
      attachments: [{ id: '1', name: `<img src=x onerror="${x}">.png`, mimeType: 'image/png', size: 1, ref: 'R' }],
    };
    const { default: SQLite } = await import('better-sqlite3');
    const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
    db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run('xss1', sid, 'gmail', 'email_thread', 'xss-ext', `<svg onload="${x}">`, `javascript:${x}`, JSON.stringify({ messages: [msg] }), new Date().toISOString());
    db.prepare('insert into message_html (item_id, message_id, html) values (?,?,?)').run('xss1', 'x1', `<p>hello</p><script>parent.${x}</script><img src=x onerror="parent.${x}"><a href="javascript:parent.${x}">link</a><meta http-equiv="refresh" content="0;url=javascript:parent.${x}"><iframe srcdoc="<script>parent.parent.${x}</script>"></iframe><form action="https://evil.example"><button id=b>go</button></form>`);
    db.close();

    const dialogs: string[] = [];
    page.on('dialog', (d) => (dialogs.push(d.message()), void d.dismiss()));
    await page.goto(WEB);
    await stream(page, /XSS/).click();
    await expect(page.locator('.top-pane .msg').first()).toContainText('Hi <script>');
    // try the links: the item's own "Open" link and every link in the message
    const open = page.locator('.top-pane .item-head a', { hasText: 'Open' });
    if (await open.count()) {
      const href = await open.getAttribute('href');
      expect(href ?? '').not.toContain('__xss'); // React 19 swaps a javascript: URL for one that only throws
      await open.click({ noWaitAfter: true }).catch(() => undefined);
    }
    for (const a of await page.locator('.top-pane .msg .body a').all()) expect((await a.getAttribute('href')) ?? '').not.toContain('__xss');
    // the original HTML: no scripts in its frame
    await page.locator('.top-pane .msg').first().getByRole('button', { name: 'Original' }).click();
    const frame = page.locator('.top-pane .msg iframe').first();
    await expect(frame).toBeVisible();
    expect((await frame.getAttribute('sandbox')) ?? '').not.toContain('allow-scripts');
    await page.frameLocator('.top-pane .msg iframe').first().locator('a', { hasText: 'link' }).click({ noWaitAfter: true }).catch(() => undefined);
    // search highlights the query without running it (focus back on the page first: the click above went into the frame)
    await page.locator('.top-pane .item-head h2').click();
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('textbox', { name: 'Search everything' }).fill(`<img src=x onerror="${x}">`);
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    expect(dialogs).toEqual([]);
  });
});

test.describe('Claude Code inside WC', () => {
  test('its actions are refused without WC\'s own page and token, even when it is on', async ({ page }) => {
    // KNOWN ISSUE (found by this suite): a hand-off folder reached through a symlink inside the home folder can point anywhere.
    test.fail();
    const s = (await api.get('/api/settings')).json;
    await api.call('PUT', '/api/settings', { ...s, claudeCode: { ...s.claudeCode, enabled: true } });
    const sid = (await api.post('/api/streams', { title: 'CC guard', summary: '' })).json.id;
    const body = JSON.stringify({ folder: '~/WorkCommander/cc-guard', task: 'x' });
    const tries: Record<string, string>[] = [
      json(), // curl-style: no Origin
      { ...json(`http://localhost:${API_PORT}`), 'x-wc-action': 'claude-code' }, // no token
      { ...json(`http://localhost:${API_PORT}`), 'x-wc-action': 'claude-code', 'x-wc-cc-token': 'guess' },
      { ...json('https://evil.example'), 'x-wc-action': 'claude-code', 'x-wc-cc-token': 'guess' },
    ];
    for (const h of tries) {
      const r = await rawRequest({ method: 'POST', path: `/api/streams/${sid}/claude-code/start`, headers: h, body });
      expect(r.status, JSON.stringify(h)).toBe(403);
    }
    // the token itself can't be read by another site (no CORS on the status call)
    const st = await rawRequest({ path: `/api/streams/${sid}/claude-code`, headers: { ...local, origin: 'https://evil.example' } });
    expect(st.headers['access-control-allow-origin']).toBeUndefined();

    // from WC's own page, with the token: folders outside the home folder, or secret ones, are refused
    await page.goto(WEB);
    const token = (await api.get(`/api/streams/${sid}/claude-code`)).json.token as string;
    const link = path.join(os.homedir(), `.wc-qa-cc-link-${process.pid}`);
    fs.rmSync(link, { force: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-qa-outside-'));
    fs.symlinkSync(outside, link);
    try {
      // (WC's own data folder is checked in the unit tests: in QA it lives outside the home folder)
      for (const folder of ['/etc', '~/../../etc', '~/.ssh/x', '~', `${link}/x`]) {
        const status = await page.evaluate(
          async ({ id, folder, token }) => (await fetch(`/api/streams/${id}/claude-code/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WC-Action': 'claude-code', 'X-WC-CC-Token': token }, body: JSON.stringify({ folder, task: 'x' }) })).status,
          { id: sid, folder, token },
        );
        expect(status, folder).toBe(400);
      }
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      await api.call('PUT', '/api/settings', { ...s, claudeCode: { ...s.claudeCode, enabled: false } });
    }
  });
});
