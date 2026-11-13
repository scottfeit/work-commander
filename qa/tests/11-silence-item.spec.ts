import path from 'node:path';
import { test, expect, freshApp, api, stream, demoDataDir, WEB } from './helpers';

freshApp();

test.beforeAll(async () => {
  const id = (await api.post('/api/streams', { title: 'Silence test', summary: '' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run(
    'sil1', id, 'gmail', 'email_thread', 'sil-ext', 'Noisy thread', null,
    JSON.stringify({ messages: [{ id: 'm1', author: { name: 'Bot' }, text: 'hello', at: '2026-10-01T00:00:00.000Z' }] }), '2026-10-01T00:00:00.000Z',
  );
  db.close();
});

test('an item can be silenced and un-silenced; the tab shows a slashed bell left of the tool logo', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /silence test/i).click();
  const tab = page.locator('.tabbar [role=tab]', { hasText: 'Noisy' });
  await expect(tab.getByRole('img', { name: 'Notifications silenced' })).toHaveCount(0);
  await tab.click();

  const btn = page.getByRole('button', { name: 'Ignore updates' });
  await btn.click();
  const bell = tab.getByRole('img', { name: 'Notifications silenced' });
  await expect(bell).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unsilence' })).toHaveAttribute('aria-pressed', 'true');
  const logo = tab.getByRole('img', { name: 'Gmail' });
  expect((await bell.boundingBox())!.x).toBeLessThan((await logo.boundingBox())!.x); // to the left of the tool logo

  await page.reload(); // remembered
  await stream(page, /silence test/i).click();
  await expect(page.locator('.tabbar [role=tab]', { hasText: 'Noisy' }).getByRole('img', { name: 'Notifications silenced' })).toBeVisible();

  await page.locator('.tabbar [role=tab]', { hasText: 'Noisy' }).click();
  await page.getByRole('button', { name: 'Unsilence' }).click(); // the same button turns it off again
  await expect(page.locator('.tabbar [role=tab]', { hasText: 'Noisy' }).getByRole('img', { name: 'Notifications silenced' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ignore updates' })).toBeVisible();
});
