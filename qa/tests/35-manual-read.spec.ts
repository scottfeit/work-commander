import path from 'node:path';
import { test, expect, freshApp, api, stream, demoDataDir, WEB } from './helpers';

freshApp();

let sid = '';
test.beforeAll(async () => {
  await api.waitPending(['ticket_create', 'email_reply']);
  sid = (await api.streams()).find((s) => /contractor access/i.test(s.title))!.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run('readItem', sid, 'gmail', 'email_thread', 'ext-read', 'Second read thread', null, JSON.stringify({ messages: [] }), new Date().toISOString());
  db.close();
});

const settings = async (ui: object) => {
  const s = (await api.get('/api/settings')).json;
  await api.call('PUT', '/api/settings', { ...s, ui: { ...s.ui, ...ui } });
};
const item = async (id: string) => (await api.get(`/api/items/${id}`)).json;

test('default: the work item has an Unread button; its tab keeps the dot until you leave and come back', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  await page.locator('.tabbar [role=tab]', { hasText: 'Second read thread' }).click();
  const head = page.locator('.top-pane .item-head');
  await expect(head.getByRole('button', { name: 'Mark item unread' })).toHaveText('Unread');
  await head.getByRole('button', { name: 'Mark item unread' }).click();
  const tab = page.locator('.tabbar [role=tab]', { hasText: 'Second read thread' });
  await expect(tab.getByLabel('new activity')).toBeVisible();
  await expect.poll(async () => (await item('readItem')).data.unread).toBe(true);
  await expect(head.getByRole('button', { name: 'Mark item unread' })).toHaveText('Unread'); // always Unread with the setting off
  // leave and come back: read
  await page.locator('.tabbar [role=tab]').first().click();
  await tab.click();
  await expect.poll(async () => (await item('readItem')).data.unread ?? false).toBe(false);
});

test('Settings → Display: mark work streams and work items Read myself', async ({ page }) => {
  await settings({ manualStreamRead: true, manualItemRead: true });
  await page.goto(`${WEB}/settings?section=display`);
  await expect(page.getByText('Mark work streams Read myself')).toBeVisible();
  await expect(page.getByText('Mark work items Read myself')).toBeVisible();

  // the stream stays unread when opened; Read / Unread flip it, and you stay on it
  await api.call('PATCH', `/api/streams/${sid}`, { unread: true });
  await api.post('/api/items/readItem/unread', {});
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  await page.waitForTimeout(500);
  expect((await api.streams()).find((s) => s.id === sid)!.unread).toBe(true);
  const tile = page.locator('.sidebar .stream.active');
  await expect(tile.getByLabel('unread')).toBeVisible();
  await tile.getByRole('button', { name: 'Mark read' }).click();
  await expect.poll(async () => (await api.streams()).find((s) => s.id === sid)!.unread).toBe(false);
  await expect(tile.getByRole('button', { name: 'Mark unread' })).toHaveText('Unread');
  await page.locator('.overview-pane').getByRole('button', { name: 'Mark unread' }).click();
  await expect.poll(async () => (await api.streams()).find((s) => s.id === sid)!.unread).toBe(true);
  await expect(page.locator('.sidebar .stream.active')).toContainText(/contractor access/i); // still on it
  await expect(page.locator('.overview-pane').getByRole('button', { name: 'Mark read' })).toHaveText('Read');
  // the row still fits on one line
  const ys = await tile.locator('.stream-actions > *').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(ys).size).toBe(1);

  // the item stays unread when its tab is open, until Read
  const tab = page.locator('.tabbar [role=tab]', { hasText: 'Second read thread' });
  await tab.click();
  await page.waitForTimeout(500);
  expect((await item('readItem')).data.unread).toBe(true);
  await expect(tab.getByLabel('new activity')).toBeVisible();
  const head = page.locator('.top-pane .item-head');
  await head.getByRole('button', { name: 'Mark item read' }).click();
  await expect.poll(async () => (await item('readItem')).data.unread ?? false).toBe(false);
  await expect(head.getByRole('button', { name: 'Mark item unread' })).toHaveText('Unread');
  await expect(tab.getByLabel('new activity')).toHaveCount(0);
  await page.locator('.app').screenshot({ path: 'qa/results/manual-read.png' });
  await settings({ manualStreamRead: false, manualItemRead: false });
});
