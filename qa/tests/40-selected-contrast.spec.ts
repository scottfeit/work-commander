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
