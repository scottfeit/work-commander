import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();

test('the + opens a popover under it; a pasted link becomes a work item and bad links are explained', async ({ page }) => {
  await api.post('/api/streams', { title: 'Add by link test', summary: '' });
  await page.goto(WEB);
  await stream(page, /add by link test/i).click();

  const plus = page.getByRole('button', { name: 'New work item from a link' });
  const bar = (await page.locator('.tabbar').boundingBox())!;
  const pb = (await plus.boundingBox())!;
  expect(pb.x + pb.width).toBeGreaterThan(bar.x + bar.width - 60); // on the right-hand side of the tab bar

  await plus.click();
  const pop = page.getByRole('dialog', { name: 'New work item from a link' });
  await expect(pop).toBeVisible();
  const pp = (await pop.boundingBox())!;
  expect(pp.y).toBeGreaterThanOrEqual(pb.y + pb.height); // just below the button
  await expect(pop.getByRole('textbox')).toBeFocused();

  // an unsupported link is explained and keeps the popover open
  await pop.getByRole('textbox').fill('https://example.com/not-supported');
  await pop.getByRole('button', { name: 'Add' }).click();
  await expect(pop).toContainText(/Slack message, a Gmail message, a Google Doc/);

  // a Google Doc link becomes a tab, which is selected; the popover closes
  await pop.getByRole('textbox').fill('https://docs.google.com/document/d/ABCDEFGHIJKLMNOP/edit');
  await pop.getByRole('button', { name: 'Add' }).click();
  await expect(pop).toHaveCount(0);
  await expect(page.locator('.tabbar [role=tab].active')).toContainText(/Google file|ABCDEFGH/);
  expect((await api.get(`/api/streams`)).json.length).toBeGreaterThan(0);

  // Escape closes it
  await plus.click();
  await expect(pop).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
});
