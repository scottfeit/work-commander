import { test, expect, freshApp, api, WEB } from './helpers';

freshApp();

test('Display settings: the two silencing options, and the mention option is unavailable while silenced items are not polled', async ({ page }) => {
  await page.goto(WEB + '/settings');
  await page.getByRole('button', { name: 'Display' }).click();
  const poll = page.getByRole('checkbox', { name: /don't poll silenced items at all/i });
  const mention = page.getByRole('checkbox', { name: /direct references to me override silencing/i });
  await expect(poll).not.toBeChecked();
  await expect(mention).toBeEnabled();

  await mention.check();
  await poll.check();
  await expect(mention).toBeDisabled(); // can't work if silenced items aren't polled
  await expect(mention).not.toBeChecked();
  await page.getByRole('button', { name: /save changes/i }).click();
  await expect(page.getByText(/settings saved/i)).toBeVisible();
  const saved = (await api.get('/api/settings')).json.silencing;
  expect(saved.skipPolling).toBe(true);

  await poll.uncheck();
  await expect(mention).toBeEnabled();
  await mention.check();
  await page.getByRole('button', { name: /save changes/i }).click();
  await expect(page.getByText(/settings saved/i)).toBeVisible();
  expect((await api.get('/api/settings')).json.silencing).toEqual({ skipPolling: false, mentionsOverride: true });
});
