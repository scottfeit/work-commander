import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();

test.beforeAll(async () => {
  await api.waitPending(['ticket_create', 'email_reply']);
});

test('viewing a ? item deselects the stream you were on; closing or declining goes back to it; accepting opens the new stream', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const contractor = page.locator('.sidebar .stream', { hasText: /contractor access/i });
  await expect(contractor).toHaveClass(/active/);
  await expect(page.locator('.tabbar [role=tab]', { hasText: /Contractor access/ })).toBeVisible();

  const q = page.locator('.sidebar .skipped-tile').first();
  await q.locator('.skipped-open').click();
  await expect(q).toHaveClass(/active/);
  await expect(contractor).not.toHaveClass(/active/); // not highlighted
  await expect(page.locator('.sidebar .stream.general')).not.toHaveClass(/active/);
  await expect(page.locator('.tabbar [role=tab]')).toHaveCount(1); // only the preview's tab
  await expect(page.locator('.tabbar [role=tab]', { hasText: /Contractor access/ })).toHaveCount(0);
  await expect(page.locator('.overview-pane')).toHaveCount(0);
  await page.screenshot({ path: 'qa/results/preview-deselects.png' });

  // close the preview: back on the stream
  await page.getByRole('button', { name: 'Close preview' }).click();
  await expect(contractor).toHaveClass(/active/);
  await expect(page.locator('.tabbar [role=tab]', { hasText: /Contractor access/ })).toBeVisible();

  // decline from the preview: back on the stream too
  await q.locator('.skipped-open').click();
  await expect(contractor).not.toHaveClass(/active/);
  await page.locator('.top-pane .item-head').getByRole('button', { name: 'Decline' }).click();
  await expect(contractor).toHaveClass(/active/);

  // accept: the new stream opens
  await page.locator('.sidebar').getByRole('checkbox', { name: /Show declined/ }).check();
  const declined = page.locator('.sidebar .skipped-tile').first();
  await declined.locator('.skipped-open').click();
  await expect(contractor).not.toHaveClass(/active/);
  const before = (await api.streams()).map((s) => s.id);
  await declined.getByRole('button', { name: 'Accept' }).click();
  await expect.poll(async () => (await api.streams()).length).toBeGreaterThan(before.length);
  const made = (await api.streams()).find((s) => !before.includes(s.id))!;
  await expect(page.locator('.sidebar .stream.active')).toContainText(made.title);
  await expect(page.locator('.overview-pane')).toBeVisible();
});
