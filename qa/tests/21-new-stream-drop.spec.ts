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
  await expect(page.getByRole('heading', { name: 'Previous overviews' })).toBeVisible();
});
