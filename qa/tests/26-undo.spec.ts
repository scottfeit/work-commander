import path from 'node:path';
import { test, expect, freshApp, api, stream, demoDataDir, WEB } from './helpers';

freshApp();

const undoBtn = (page: import('@playwright/test').Page) => page.locator('.brand').getByRole('button', { name: /^Undo/ });

test.beforeAll(async () => {
  await api.waitPending(['ticket_create', 'email_reply']);
});

test('Email items have Mark read, Archive and Delete for the Gmail thread; each turns into its undo; the item stays put', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  await page.locator('.tabbar').getByRole('img', { name: 'Gmail' }).click();
  const g = page.locator('.top-pane .gmail-actions');
  await expect(g.locator('button > span:first-child')).toHaveText(['Mark read', 'Archive', 'Delete']);
  // outlined, like Allow
  expect(await g.getByRole('button', { name: 'Delete' }).evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe('rgba(0, 0, 0, 0)');

  // clicking doesn't resize anything: each button keeps its width, so the toolbar doesn't shift
  const widths = () => g.getByRole('button').evaluateAll((bs) => bs.map((b) => Math.round(b.getBoundingClientRect().width)));
  const w0 = await widths();
  await g.getByRole('button', { name: 'Mark read' }).click();
  await expect(g.getByRole('button', { name: 'Mark unread' })).toBeVisible();
  expect(await widths()).toEqual(w0);
  await g.getByRole('button', { name: 'Archive' }).click();
  await expect(g.getByRole('button', { name: 'Unarchive' })).toBeVisible();
  await g.getByRole('button', { name: 'Delete' }).click();
  await expect(g.getByRole('button', { name: 'Undelete' })).toBeVisible();
  expect(await widths()).toEqual(w0);
  await expect(g.getByRole('button', { name: /archive/i })).toBeDisabled(); // stays in place while in Trash
  await expect(page.locator('.top-pane .item-head')).toContainText(/contractor/i); // still in the stream
  await expect(page.locator('.tabbar').getByRole('img', { name: 'Gmail' })).toBeVisible();

  // the state is Gmail's, so it holds after a reload
  await page.reload();
  await stream(page, /contractor access/i).click();
  await page.locator('.tabbar').getByRole('img', { name: 'Gmail' }).click();
  await expect(g.getByRole('button', { name: 'Undelete' })).toBeVisible();
  await expect(g.getByRole('button', { name: 'Mark unread' })).toBeVisible();

  // the Undo button (left of Settings) reverses the delete
  const [u, gear] = await Promise.all([undoBtn(page).boundingBox(), page.locator('.brand').getByRole('button', { name: 'Settings' }).boundingBox()]);
  expect(u!.x).toBeLessThan(gear!.x);
  await expect(undoBtn(page)).toHaveAttribute('title', /^Undo: delete "/);
  await undoBtn(page).click();
  await expect(g.getByRole('button', { name: 'Delete' })).toBeVisible();
  await expect(page.locator('.toast')).toContainText(/Delete "/);
  // Undelete with the button directly, then put things back for the other tests
  await g.getByRole('button', { name: 'Unarchive' }).click();
  await g.getByRole('button', { name: 'Mark unread' }).click();
  await expect(g.locator('button > span:first-child')).toHaveText(['Mark read', 'Archive', 'Delete']);
});

test('Undo puts a moved work item back, bringing back the stream it emptied; ⌘Z works too; up to three steps', async ({ page }) => {
  const a = (await api.post('/api/streams', { title: 'Undo source stream', summary: 'Source overview' })).json.id;
  const b = (await api.post('/api/streams', { title: 'Undo target stream', summary: '' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run('undoItem', a, 'gmail', 'email_thread', 'ext-undo', 'Undo me thread', null, JSON.stringify({ messages: [] }), new Date().toISOString());
  db.close();

  await page.goto(WEB);
  await api.post('/api/items/undoItem/move', { streamId: b });
  await expect(stream(page, /undo source stream/i)).toHaveCount(0); // emptied, so removed
  await api.call('PATCH', `/api/streams/${b}`, { pending: true });
  await api.call('PATCH', `/api/streams/${b}`, { title: 'Undo target renamed' });
  await expect(undoBtn(page)).toHaveAttribute('title', /rename "Undo target stream"/);

  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+z'); // rename
  await expect(stream(page, /undo target stream/i)).toBeVisible();
  await undoBtn(page).click(); // pending
  await expect.poll(async () => (await api.streams()).find((s) => s.id === b)?.pending).toBe(false);
  await undoBtn(page).click(); // the move
  await expect(stream(page, /undo source stream/i)).toBeVisible();
  expect((await api.get('/api/items/undoItem')).json.streamId).toBe(a);
  expect((await api.get('/api/streams?includeClosed=1')).json.find((s: any) => s.id === a).summary).toBe('Source overview');
});

test('⌘Z inside a text box undoes typing, not an action; the toast can be turned off', async ({ page }) => {
  const id = (await api.post('/api/streams', { title: 'Undo toast stream', summary: '' })).json.id;
  await api.call('PATCH', `/api/streams/${id}`, { pending: true });
  await page.goto(WEB);
  await page.getByPlaceholder('Filter streams').fill('abc');
  await page.getByPlaceholder('Filter streams').press('ControlOrMeta+z');
  expect((await api.streams()).find((s) => s.id === id)?.pending).toBe(true);
  await page.getByPlaceholder('Filter streams').fill('');

  const s = (await api.get('/api/settings')).json;
  await api.call('PUT', '/api/settings', { ...s, ui: { ...s.ui, undoToast: false } });
  await page.goto(`${WEB}/settings?section=display`);
  await expect(page.getByText('Show a message saying what was undone')).toBeVisible();
  await page.goto(WEB);
  await undoBtn(page).click();
  await expect.poll(async () => (await api.streams()).find((x) => x.id === id)?.pending).toBe(false);
  await page.waitForTimeout(300);
  await expect(page.locator('.toast')).toHaveCount(0);
  await api.call('PUT', '/api/settings', { ...s, ui: { ...s.ui, undoToast: true } });
});
