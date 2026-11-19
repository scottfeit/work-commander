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
