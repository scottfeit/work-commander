import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();

const tile = (page: import('@playwright/test').Page, re: RegExp) => page.locator('.stream', { hasText: re });

test('Pending: the alarm clock on the selected tile and on the Overview, a collapsible Pending section, light-grey tiles, same ordering', async ({ page }) => {
  await api.post('/api/streams', { title: 'Alpha pending test', summary: '' });
  await api.post('/api/streams', { title: 'Beta pending test', summary: '' });
  await page.goto(WEB);

  // the check sits to the right of Close stream on the selected tile
  await stream(page, /alpha pending test/i).click();
  const actions = tile(page, /alpha pending test/i).locator('.stream-actions');
  const close = actions.getByRole('button', { name: 'Close stream' });
  const check = actions.getByRole('button', { name: 'Mark pending' });
  expect((await check.boundingBox())!.x).toBeGreaterThan((await close.boundingBox())!.x);
  const normalColor = await tile(page, /beta pending test/i).locator('.stream-title').evaluate((el) => getComputedStyle(el).color);

  await check.click();
  const header = page.getByRole('button', { name: /^Pending · 1/ });
  await expect(header).toBeVisible();
  await expect(tile(page, /alpha pending test/i)).toHaveClass(/pending/);
  const stillOpen = (await api.get('/api/streams')).json.find((s: any) => /alpha pending/i.test(s.title));
  expect(stillOpen.status).toBe('open');
  expect(stillOpen.pending).toBe(true);
  // below the Open list
  const [bOpen, aPend] = await Promise.all([tile(page, /beta pending test/i).boundingBox(), tile(page, /alpha pending test/i).boundingBox()]);
  expect(aPend!.y).toBeGreaterThan(bOpen!.y);
  // light-grey text for a pending tile that isn't selected
  await stream(page, /beta pending test/i).click();
  const greyColor = await tile(page, /alpha pending test/i).locator('.stream-title').evaluate((el) => getComputedStyle(el).color);
  expect(greyColor).not.toBe(normalColor);

  // the Pending header collapses and expands
  await header.click();
  await expect(tile(page, /alpha pending test/i)).toHaveCount(0);
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await header.click();
  await expect(tile(page, /alpha pending test/i)).toBeVisible();

  // pending streams keep the usual ordering (most recently updated first) within the section
  await tile(page, /beta pending test/i).locator('.stream-actions').getByRole('button', { name: 'Mark pending' }).click();
  await expect(page.getByRole('button', { name: /^Pending · 2/ })).toBeVisible();
  const [yb, ya] = await Promise.all([tile(page, /beta pending test/i).boundingBox(), tile(page, /alpha pending test/i).boundingBox()]);
  expect(yb!.y).toBeLessThan(ya!.y); // Beta was created later, so it is more recent

  // the Overview has the same check, to the left of Mark unread; pressing it puts the stream back in Open
  await page.locator('.tabbar [role=tab]', { hasText: 'Overview' }).click();
  const ov = page.locator('.item-view.overview');
  const ovCheck = ov.getByRole('button', { name: /pending: put back in open/i });
  await expect(ovCheck).toBeVisible();
  expect((await ovCheck.boundingBox())!.x).toBeLessThan((await ov.getByRole('button', { name: 'Mark unread' }).boundingBox())!.x);
  await ovCheck.click();
  await expect(page.getByRole('button', { name: /^Pending · 1/ })).toBeVisible();
  await expect(tile(page, /beta pending test/i)).not.toHaveClass(/pending/);
  expect((await api.get('/api/streams')).json.find((s: any) => /beta pending/i.test(s.title)).pending).toBe(false);
});
