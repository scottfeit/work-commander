import path from 'node:path';
import { test, expect, freshApp, api, stream, demoDataDir, WEB } from './helpers';

freshApp();

test.beforeAll(async () => {
  await api.waitPending(['ticket_create', 'email_reply']);
});

test('keyboard triage: j/k move through the list, p toggles Pending, tabs with ] and [, d declines a ? item, / filters, ? lists the shortcuts', async ({ page }) => {
  await page.goto(WEB);
  // the current tile: a ? item being viewed, otherwise the selected work stream
  const current = () => page.evaluate(() => (document.querySelector('.sidebar .skipped-tile.active') ?? document.querySelector('.sidebar .stream.active:not(.general)'))?.querySelector('.stream-title')?.textContent ?? null);
  await expect(page.locator('.sidebar .skipped-tile').first()).toBeVisible(); // the list has loaded
  await page.keyboard.press('j');
  await expect.poll(current).not.toBeNull();
  const first = (await current())!;
  await page.keyboard.press('j');
  await expect.poll(current).not.toBe(first);
  await page.keyboard.press('k');
  await expect.poll(current).toBe(first);

  // p: Pending on, and off again
  const sid = (await api.streams()).find((s) => s.title === first)!.id;
  await page.keyboard.press('p');
  await expect.poll(async () => (await api.streams()).find((s) => s.id === sid)?.pending).toBe(true);
  await page.keyboard.press('p');
  await expect.poll(async () => (await api.streams()).find((s) => s.id === sid)?.pending).toBe(false);

  // ] and [ move between the stream's tabs (give it a second one)
  const home = (await api.streams()).find((s) => /contractor access/i.test(s.title))!.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run('kbItem', home, 'gmail', 'email_thread', 'ext-kb', 'Second tab thread', null, JSON.stringify({ messages: [] }), new Date().toISOString());
  db.close();
  await page.reload();
  await stream(page, /contractor access/i).click();
  const tabs = page.locator('.tabbar [role=tab]');
  await expect.poll(() => tabs.count()).toBeGreaterThan(1);
  await page.keyboard.press(']');
  await expect(tabs.nth(1)).toHaveClass(/active/);
  await page.keyboard.press('[');
  await expect(tabs.nth(0)).toHaveClass(/active/);

  // d on a "?" item declines it
  const q = page.locator('.sidebar .skipped-tile').first();
  const qTitle = (await q.locator('.stream-title').textContent())!;
  await q.locator('.skipped-open').click();
  await expect(q).toHaveClass(/active/);
  await page.keyboard.press('d');
  await expect(page.locator('.sidebar .skipped-tile', { hasText: qTitle })).toHaveCount(0);

  // shortcuts don't fire while typing; / focuses the filter, Esc leaves it
  await page.keyboard.press('/');
  await expect(page.getByPlaceholder('Filter streams')).toBeFocused();
  await page.keyboard.type('jk');
  await expect(page.getByPlaceholder('Filter streams')).toHaveValue('jk');
  await page.keyboard.press('Escape');
  await page.getByPlaceholder('Filter streams').fill('');
  await page.locator('body').click({ position: { x: 600, y: 300 } });

  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toContainText('Next work stream or proposal');
  await page.screenshot({ path: 'qa/results/shortcuts.png' });
  await page.keyboard.press('j'); // inert while the list is open
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
});
