import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();

test('Pending ▾: snooze to a preset or a typed time (read back to confirm); the tile says until when', async ({ page }) => {
  const id = (await api.post('/api/streams', { title: 'Snooze me stream', summary: 'Waiting on Dana' })).json.id;
  await page.goto(WEB);
  await stream(page, /snooze me stream/i).click();
  const tile = page.locator('.sidebar .stream.active');
  await tile.getByRole('button', { name: 'Snooze until…' }).click();
  const menu = page.getByRole('menu', { name: 'Snooze until' });
  await expect(menu.getByRole('menuitem')).toContainText(['Pending', 'Later today', 'Tomorrow']);
  await page.screenshot({ path: 'qa/results/snooze-menu.png' });
  await menu.getByRole('menuitem', { name: /^Tomorrow/ }).click();
  await expect.poll(async () => (await api.streams()).find((s) => s.id === id)?.snoozeUntil).toBeTruthy();
  const until = new Date((await api.streams()).find((s) => s.id === id)!.snoozeUntil!);
  expect(until.getHours()).toBe(9);
  expect(until.getDate()).toBe(new Date(Date.now() + 86_400_000).getDate());
  await expect(page.locator('.sidebar .stream', { hasText: 'Snooze me stream' })).toContainText('until tomorrow 9:00');

  // a typed time is read, shown back, and used only when confirmed
  await stream(page, /snooze me stream/i).click();
  await tile.getByRole('button', { name: 'Snooze until…' }).click();
  await menu.getByLabel('Type a time').fill('never');
  await menu.getByRole('button', { name: 'Read' }).click();
  await expect(menu).toContainText("doesn't name a time");
  await menu.getByLabel('Type a time').fill('the Thursday after next, 2pm');
  await menu.getByRole('button', { name: 'Read' }).click();
  const confirm = menu.getByRole('button', { name: /^Snooze until / });
  await expect(confirm).toBeVisible();
  await page.screenshot({ path: 'qa/results/snooze-typed.png' });
  await confirm.click();
  await expect.poll(async () => new Date((await api.streams()).find((s) => s.id === id)!.snoozeUntil!).getHours()).toBe(14);

  // plain Pending clears the date
  await stream(page, /snooze me stream/i).click();
  await tile.getByRole('button', { name: 'Snooze until…' }).click();
  await menu.getByRole('menuitem', { name: /^Pending/ }).click();
  await expect.poll(async () => (await api.streams()).find((s) => s.id === id)?.snoozeUntil ?? null).toBeNull();
  expect((await api.streams()).find((s) => s.id === id)?.pending).toBe(true);
});
