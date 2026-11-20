import { test, expect, freshApp, stream, WEB } from './helpers';

freshApp();

test('the selected work stream stands out: accent bar down the left, tinted background', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const sel = page.locator('.sidebar .stream.active');
  const other = page.locator('.sidebar .stream:not(.active):not(.general)').first();
  const [a, b] = await Promise.all([sel.evaluate((e) => getComputedStyle(e).backgroundColor), other.evaluate((e) => getComputedStyle(e).backgroundColor)]);
  expect(a).not.toBe(b);
  expect(await sel.evaluate((e) => getComputedStyle(e).boxShadow)).toMatch(/inset/);
  await page.locator('.sidebar').screenshot({ path: 'qa/results/selected-stream.png' });
});

test('pop-up messages close with their × or a click anywhere on them', async ({ page }) => {
  const { api } = await import('./helpers');
  const a = (await api.post('/api/streams', { title: 'Toast stream', summary: '' })).json.id;
  await page.goto(WEB);
  const toast = page.locator('.toast');
  await api.call('PATCH', `/api/streams/${a}`, { title: 'Toast stream 2' });
  await page.locator('.brand').getByRole('button', { name: /^Undo/ }).click();
  await expect(toast).toHaveCount(1);
  await page.locator('.toasts').screenshot({ path: 'qa/results/toast.png' });
  await toast.getByRole('button', { name: 'Close' }).click();
  await expect(toast).toHaveCount(0);
  await api.call('PATCH', `/api/streams/${a}`, { title: 'Toast stream 3' });
  await page.locator('.brand').getByRole('button', { name: /^Undo/ }).click();
  await expect(toast).toHaveCount(1);
  await toast.locator('strong').click();
  await expect(toast).toHaveCount(0);
});

test('a closed work stream has a Reopen button on its card', async ({ page }) => {
  const { api } = await import('./helpers');
  const id = (await api.post('/api/streams', { title: 'Reopen card stream', summary: '' })).json.id;
  await api.call('PATCH', `/api/streams/${id}`, { status: 'closed' });
  await page.goto(WEB);
  await page.locator('.sidebar').getByRole('checkbox', { name: /Show closed/ }).check();
  await stream(page, /reopen card stream/i).click();
  const card = page.locator('.sidebar .stream.active');
  await expect(card.getByRole('button', { name: 'Close stream' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Reopen stream' }).click();
  await expect.poll(async () => (await api.get('/api/streams?includeClosed=1')).json.find((s: any) => s.id === id).status).toBe('open');
  await expect(page.locator('.sidebar .stream.active').getByRole('button', { name: 'Close stream' })).toBeVisible();
});

test('a stream reopened by new activity shows a "Reopened" chip', async ({ page }) => {
  const { api, demoDataDir } = await import('./helpers');
  const path = await import('node:path');
  const id = (await api.post('/api/streams', { title: 'Reopened chip stream', summary: '' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('update streams set reopened_at = ? where id = ?').run(new Date().toISOString(), id);
  db.close();
  await page.goto(WEB);
  const card = page.locator('.sidebar .stream', { hasText: 'Reopened chip stream' });
  await expect(card.locator('.reopened-chip')).toHaveText('Reopened');
  await card.screenshot({ path: 'qa/results/reopened-chip.png' });
  await api.call('PATCH', `/api/streams/${id}`, { pending: true }); // your next move clears it
  await expect(page.locator('.sidebar .stream', { hasText: 'Reopened chip stream' }).locator('.reopened-chip')).toHaveCount(0);
});

test('each stream card shows how many work items it holds, in the corner of its tool icon', async ({ page }) => {
  const { api: a, demoDataDir } = await import('./helpers');
  const path = await import('node:path');
  const id = (await a.post('/api/streams', { title: 'Count badge stream', summary: '' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  for (const n of [1, 2, 3]) db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run(`cnt${n}`, id, 'gmail', 'email_thread', `cnt-${n}`, `Thread ${n}`, null, '{"messages":[]}', new Date().toISOString());
  db.close();
  await page.goto(WEB);
  const card = page.locator('.sidebar .stream', { hasText: 'Count badge stream' });
  await expect(card.locator('.src-count')).toHaveText('3');
  await expect(card.locator('.src-count')).toHaveAttribute('aria-label', '3 work items');
  await card.locator('.stream-head').screenshot({ path: 'qa/results/item-count.png' });
});
