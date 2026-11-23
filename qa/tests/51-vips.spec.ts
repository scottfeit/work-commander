import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();

test('VIPs: a VIP column in People, the "Make my managers VIPs" button, and the red VIP chip on the card', async ({ page }) => {
  await page.goto(`${WEB}/settings?section=pu`);
  const jordan = page.getByRole('checkbox', { name: 'VIP: Jordan Lee' });
  await expect(jordan).not.toBeChecked();
  await page.getByRole('button', { name: 'Make my managers VIPs' }).click();
  await expect(jordan).toBeChecked(); // Alex's manager
  await expect(page.getByText('Your managers are VIPs')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make my managers VIPs' })).toHaveCount(0); // one-way
  await expect(page.getByRole('checkbox', { name: 'VIP: Priya Shah' })).not.toBeChecked();
  // anyone can be ticked by hand; Lee wrote the latest message on the contractor-access thread
  await page.getByRole('checkbox', { name: 'VIP: Lee Wong' }).check();
  await page.locator('.vip-lineage').screenshot({ path: 'qa/results/vip-lineage.png' });
  expect((await api.get('/api/vips')).json.list).toEqual(expect.arrayContaining([{ email: 'lee.wong@example.com', vip: true, origin: 'manual' }, { email: 'jordan.lee@example.com', vip: true, origin: 'lineage' }]));

  await page.goto(WEB);
  const card = stream(page, /contractor access/i);
  const chip = card.locator('.vip-chip');
  await expect(chip).toHaveText('VIP');
  const bg = await chip.evaluate((e) => getComputedStyle(e).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g)!.map(Number);
  expect(r).toBeGreaterThan(150);
  expect(g).toBeLessThan(r / 2);
  expect(b).toBeLessThan(r / 2);
  await card.screenshot({ path: 'qa/results/vip-chip.png' });

  // un-ticking takes the chip away
  await page.goto(`${WEB}/settings?section=pu`);
  await page.getByRole('checkbox', { name: 'VIP: Lee Wong' }).uncheck();
  await page.goto(WEB);
  await expect(stream(page, /contractor access/i).locator('.vip-chip')).toHaveCount(0);
});
