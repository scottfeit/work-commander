import { test, expect, freshApp, api, WEB } from './helpers';

freshApp();

test('Pause and resume polling and triage by hand: a banner says so, with Resume; the gap setting is under Status', async ({ page }) => {
  await page.goto(WEB);
  const brand = page.locator('.brand');
  const [pause, undo] = await Promise.all([brand.getByRole('button', { name: 'Pause polling and triage' }).boundingBox(), brand.getByRole('button', { name: /^Undo/ }).boundingBox()]);
  expect(pause!.x).toBeLessThan(undo!.x); // left of Undo
  await brand.getByRole('button', { name: 'Pause polling and triage' }).click();
  const banner = page.locator('.polling-banner');
  await expect(banner).toContainText('Polling and triage are paused');
  await expect(banner).toContainText('You paused them');
  expect((await api.get('/api/polling')).json.paused).toMatchObject({ reason: 'manual' });
  await page.locator('.app').screenshot({ path: 'qa/results/polling-paused.png' });

  // stays paused across a reload
  await page.reload();
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Resume' }).click();
  await expect(banner).toHaveCount(0);
  expect((await api.get('/api/polling')).json.paused).toBeNull();

  // the pause button in the header also resumes
  await api.post('/api/polling/pause', {});
  await expect(banner).toBeVisible();
  await brand.getByRole('button', { name: 'Resume polling and triage' }).click();
  await expect(banner).toHaveCount(0);

  await page.goto(`${WEB}/settings?section=status`);
  await expect(page.getByLabel('Pause after gap hours')).toHaveValue('2');
});
