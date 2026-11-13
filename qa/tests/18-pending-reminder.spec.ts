import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test, expect, freshApp, api, stream, WEB, demoDataDir } from './helpers';

freshApp();

const backdate = (id: string, days: number) => {
  const at = new Date(Date.now() - days * 86_400_000).toISOString();
  execFileSync('sqlite3', [path.join(demoDataDir(), 'work-commander.sqlite'), `UPDATE streams SET last_activity_at='${at}', pending_at='${at}' WHERE id='${id}'`]);
};
const find = async (re: RegExp) => (await api.get('/api/streams')).json.find((s: any) => re.test(s.title));

test('Snooze button is an orange alarm clock, not a check mark', async ({ page }) => {
  await api.post('/api/streams', { title: 'Alarm look test', summary: '' });
  await page.goto(WEB);
  await stream(page, /alarm look test/i).click();
  const btn = page.locator('.stream.active .stream-actions').getByRole('button', { name: 'Mark pending' });
  await expect(btn.locator('svg')).toBeVisible();
  await expect(btn).not.toContainText('✓');
  const [r, g, b] = (await btn.evaluate((el) => getComputedStyle(el).color)).match(/\d+/g)!.map(Number);
  expect(r).toBeGreaterThan(200); // orange: strong red, medium green, little blue
  expect(g).toBeGreaterThan(80);
  expect(g).toBeLessThan(180);
  expect(b).toBeLessThan(80);
});

test('A pending stream untouched for 3 days comes back at the top as a Reminder, marked unread', async ({ page }) => {
  await api.post('/api/streams', { title: 'Waiting on vendor', summary: '' });
  await api.post('/api/streams', { title: 'Busy stream', summary: '' });
  const s = await find(/waiting on vendor/i);
  await api.call('PATCH', `/api/streams/${s.id}`, { pending: true, unread: false });
  backdate(s.id, 4);
  await page.goto(WEB);
  await expect(page.getByRole('button', { name: /^Pending · 1/ })).toBeVisible();

  expect((await api.post('/api/reminders/check')).json.surfaced).toEqual([s.id]);
  const after = await find(/waiting on vendor/i);
  expect(after.pending).toBe(false);
  expect(after.unread).toBe(true);
  expect(after.reminderAt).toBeTruthy();

  const tile = page.locator('.stream', { hasText: /waiting on vendor/i });
  await expect(tile.locator('.chip.reminder')).toHaveText('Reminder');
  await expect(page.getByRole('button', { name: /^Pending ·/ })).toHaveCount(0);
  const [a, b] = await Promise.all([tile.boundingBox(), page.locator('.stream', { hasText: /busy stream/i }).boundingBox()]);
  expect(a!.y).toBeLessThan(b!.y); // above the other open stream

  // snoozing it again clears the Reminder
  await stream(page, /waiting on vendor/i).click();
  await page.locator('.stream.active .stream-actions').getByRole('button', { name: 'Mark pending' }).click();
  await expect(page.getByRole('button', { name: /^Pending · 1/ })).toBeVisible();
  await expect(page.locator('.chip.reminder')).toHaveCount(0);
});

test('Settings: reminder days default to 3; 0 means never surface', async ({ page }) => {
  await page.goto(WEB + '/settings');
  await page.getByRole('button', { name: 'Display' }).click();
  const days = page.getByRole('spinbutton', { name: 'Pending reminder days' });
  await expect(days).toHaveValue('3');
  await days.fill('0');
  await page.getByRole('button', { name: /save changes/i }).click();
  await expect(page.getByText(/settings saved/i)).toBeVisible();
  expect((await api.get('/api/settings')).json.reminders.pendingDays).toBe(0);

  await api.post('/api/streams', { title: 'Never reminded', summary: '' });
  const s = await find(/never reminded/i);
  await api.call('PATCH', `/api/streams/${s.id}`, { pending: true });
  backdate(s.id, 60);
  expect((await api.post('/api/reminders/check')).json.surfaced).toEqual([]);
  expect((await find(/never reminded/i)).pending).toBe(true);
});
