import path from 'node:path';
import { test, expect, freshApp, api, stream, demoDataDir, WEB } from './helpers';

freshApp();

let streamId = '';
let streamB = '';
const TITLES = ['Alpha thread', 'Beta thread', 'Gamma thread'];

test.beforeAll(async () => {
  streamId = (await api.post('/api/streams', { title: 'Tab drag test', summary: '' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  TITLES.forEach((t, i) =>
    db
      .prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)')
      .run(`it${i}`, streamId, 'gmail', 'email_thread', `ext${i}`, t, null, JSON.stringify({ messages: [] }), `2026-10-0${i + 1}T00:00:00.000Z`),
  );
  streamB = (await api.post('/api/streams', { title: 'Tab drag recent-first', summary: '' })).json.id;
  TITLES.forEach((t, i) =>
    db
      .prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)')
      .run(`bt${i}`, streamB, 'gmail', 'email_thread', `bext${i}`, t, null, JSON.stringify({ messages: [] }), `2026-10-0${i + 1}T00:00:00.000Z`),
  );
  db.close();
});

const order = (page: import('@playwright/test').Page) => page.locator('.tabbar [role=tab] .tab-title').allTextContents();

test('tabs can be rearranged by dragging, including into the first position, and Overview stays put', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /tab drag test/i).click();
  const tab = (name: string) => page.locator('.tabbar [role=tab]', { hasText: name });
  await expect(tab('Gamma')).toBeVisible();
  expect(await order(page)).toEqual(TITLES);

  // Gamma onto the left half of Alpha: first position.
  await tab('Gamma').dragTo(tab('Alpha'), { targetPosition: { x: 6, y: 10 } });
  await expect.poll(() => order(page)).toEqual(['Gamma thread', 'Alpha thread', 'Beta thread']);

  // Beta onto the Overview tab also means "first".
  await tab('Beta').dragTo(page.locator('.tabbar [role=tab]', { hasText: 'Overview' }));
  await expect.poll(() => order(page)).toEqual(['Beta thread', 'Gamma thread', 'Alpha thread']);
  await expect(page.locator('.tabbar [role=tab]').first()).toHaveText('Overview');

  // Remembered by the server.
  await page.reload();
  await stream(page, /tab drag test/i).click();
  await expect.poll(() => order(page)).toEqual(['Beta thread', 'Gamma thread', 'Alpha thread']);
});

test('with "most recent tab first" on, a tab you drag to the first position stays there', async ({ page }) => {
  const settings = (await api.get('/api/settings')).json;
  expect((await api.call('PUT', '/api/settings', { ...settings, ui: { ...settings.ui, recentTabFirst: true } })).status).toBe(200);
  await page.goto(WEB);
  await stream(page, /recent-first/i).click();
  const tab = (name: string) => page.locator('.tabbar [role=tab]', { hasText: name });
  await expect(tab('Gamma')).toBeVisible();
  // newest activity (Gamma) is hoisted next to Overview
  await expect.poll(() => order(page)).toEqual(['Gamma thread', 'Alpha thread', 'Beta thread']);
  // dragging Alpha into the first position must win over the hoist
  await tab('Alpha').dragTo(tab('Gamma'), { targetPosition: { x: 6, y: 10 } });
  await expect.poll(() => order(page)).toEqual(['Alpha thread', 'Gamma thread', 'Beta thread']);
  await page.reload();
  await stream(page, /recent-first/i).click();
  await expect.poll(() => order(page)).toEqual(['Alpha thread', 'Gamma thread', 'Beta thread']);
});

test('"Opening a work stream" can land on the most recently updated item tab', async ({ page }) => {
  const settings = (await api.get('/api/settings')).json;
  await api.call('PUT', '/api/settings', { ...settings, ui: { ...settings.ui, recentTabFirst: false, openTab: 'overview' } });
  await page.goto(WEB);
  await stream(page, /tab drag test/i).click();
  await expect(page.locator('.tabbar [role=tab].active')).toHaveText('Overview');

  await api.call('PUT', '/api/settings', { ...settings, ui: { ...settings.ui, recentTabFirst: false, openTab: 'recent' } });
  await page.goto(WEB); // settings are read at load
  await page.getByRole('button', { name: /all open work/i }).click();
  await stream(page, /tab drag test/i).click();
  await expect(page.locator('.tabbar [role=tab].active')).toContainText('Gamma'); // the newest item
  // and switching back to Overview or another stream still behaves normally
  await page.locator('.tabbar [role=tab]', { hasText: 'Overview' }).click();
  await expect(page.locator('.tabbar [role=tab].active')).toHaveText('Overview');
});
