import path from 'node:path';
import { test, expect, freshApp, api, stream, demoDataDir, WEB } from './helpers';

freshApp();

let one = '';
let two = '';

test.beforeAll(async () => {
  one = (await api.post('/api/streams', { title: 'Drop source single', summary: '' })).json.id;
  two = (await api.post('/api/streams', { title: 'Drop source pair', summary: '' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  const add = (id: string, streamId: string, title: string) =>
    db
      .prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)')
      .run(id, streamId, 'gmail', 'email_thread', `ext-${id}`, title, null, JSON.stringify({ messages: [{ id: `m-${id}`, author: { name: 'Dana' }, text: `About ${title}`, at: '2026-10-01T00:00:00.000Z' }] }), '2026-10-01T00:00:00.000Z');
  add('dropA', one, 'Lonely thread');
  add('dropB', two, 'Vendor renewal thread');
  add('dropC', two, 'Kept thread');
  db.close();
});

const plus = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'New work stream' });

test('Dropping a work item on "+" starts a new work stream with it, and the old stream keeps its other items', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /drop source pair/i).click();
  await page.locator('.linked .link-row', { hasText: 'Vendor renewal thread' }).dragTo(plus(page));
  // The new stream opens, named and summarised by the (scripted) triage model.
  await expect(page.locator('.title-input')).toHaveValue('Vendor renewal thread');
  await expect(page.locator('.summary-input')).toHaveValue(/Refreshed overview: Vendor renewal thread/);
  await expect(page.locator('.linked .link-row')).toHaveCount(1);
  await expect(stream(page, /drop source pair/i)).toBeVisible();
  const items = (await api.get(`/api/streams/${two}/items`)).json as any[];
  expect(items.map((i) => i.title)).toEqual(['Kept thread']);
});

test('Moving the last item out of a work stream removes that stream', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /drop source single/i).click();
  await page.locator('.linked .link-row', { hasText: 'Lonely thread' }).dragTo(stream(page, /drop source pair/i));
  await expect(stream(page, /drop source single/i)).toHaveCount(0);
  // You were looking at it, so you follow the item.
  await expect(page.locator('.title-input')).toHaveValue('Drop source pair');
  expect((await api.streams()).some((s) => s.id === one)).toBe(false);
});

test('Refresh overview rewrites the overview and keeps the old one', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /drop source pair/i).click();
  await page.getByRole('button', { name: 'Refresh overview' }).click();
  await expect(page.locator('.summary-input')).toHaveValue(/^Refreshed overview: .*Kept thread/);
  // Previous overviews: collapsed at first; the triangle opens them, and that holds for other streams and after a reload
  const toggle = page.getByRole('button', { name: /Previous overviews/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.summary-history')).toHaveCount(0);
  await toggle.click();
  await expect(page.locator('.summary-history li').first()).toBeVisible();
  await page.locator('.overview-pane').screenshot({ path: 'qa/results/previous-overviews.png' });
  await page.reload();
  await stream(page, /drop source pair/i).click();
  await expect(page.getByRole('button', { name: /Previous overviews/ })).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: /Previous overviews/ }).click();
  await expect(page.locator('.summary-history')).toHaveCount(0);
});

test('a work item can be dragged onto a closed work stream, which stays closed', async ({ page }) => {
  const closed = (await api.post('/api/streams', { title: 'Closed drop target', summary: '' })).json.id;
  await api.call('PATCH', `/api/streams/${closed}`, { status: 'closed' });
  const src = (await api.post('/api/streams', { title: 'Closed drop source', summary: '' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  for (const [id, title] of [['cdA', 'To the closed one'], ['cdB', 'Stays here']])
    db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run(id, src, 'gmail', 'email_thread', `ext-${id}`, title, null, JSON.stringify({ messages: [] }), '2026-10-01T00:00:00.000Z');
  db.close();
  await page.goto(WEB);
  await page.locator('.sidebar').getByRole('checkbox', { name: /Show closed/ }).check();
  await stream(page, /closed drop source/i).click();
  await page.locator('.tabbar [role=tab]', { hasText: 'To the closed one' }).dragTo(stream(page, /closed drop target/i));
  await expect.poll(async () => (await api.get('/api/items/cdA')).json.streamId).toBe(closed);
  const st = (await api.get('/api/streams?includeClosed=1')).json.find((s: any) => s.id === closed);
  expect(st.status).toBe('closed');
});
