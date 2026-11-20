import { test, expect, freshApp, api, WEB } from './helpers';

freshApp();

test.beforeAll(async () => {
  await api.waitPending(['ticket_create', 'email_reply']);
});

test('search everything: ⌘K, s, or Enter in the filter; results grouped (closed work too); opening a message goes to its stream and tab', async ({ page }) => {
  const closed = (await api.post('/api/streams', { title: 'Archived Northwind kickoff', summary: 'Old contractor onboarding notes' })).json.id;
  await api.call('PATCH', `/api/streams/${closed}`, { status: 'closed' });
  await page.goto(WEB);
  await expect(page.locator('.sidebar .stream:not(.general)').first()).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  const dlg = page.getByRole('dialog', { name: 'Search everything' });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('textbox', { name: 'Search everything' }).fill('northwind');
  await expect(dlg.locator('section h3')).toContainText([/Work streams/, /Messages/]);
  await expect(dlg.locator('.search-hit', { hasText: 'Archived Northwind kickoff' })).toContainText('closed');
  await page.screenshot({ path: 'qa/results/search.png' });

  // open a message: its stream opens on that tab
  const hit = dlg.locator('section', { hasText: 'Messages' }).locator('.search-hit').first();
  const title = (await hit.locator('.search-hit-title').textContent())!.trim();
  await hit.click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('.tabbar [role=tab].active')).toContainText(title.slice(0, 20));

  // "s" opens it too; Esc closes
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await page.keyboard.press('s');
  await expect(dlg).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);

  // from the filter: Enter searches everything for what's typed; a closed stream opens (and Show closed turns on)
  await page.getByPlaceholder('Filter streams').fill('kickoff');
  await expect(page.getByRole('button', { name: /Search everything for "kickoff"/ })).toBeVisible();
  await page.getByPlaceholder('Filter streams').press('Enter');
  await expect(dlg.getByRole('textbox')).toHaveValue('kickoff');
  await expect(dlg.locator('.search-hit').first()).toContainText('Archived Northwind kickoff');
  await dlg.getByRole('textbox').press('Enter');
  await expect(page.getByLabel('Work stream title')).toHaveValue('Archived Northwind kickoff');
  await expect(page.locator('.overview-pane')).toContainText('Reopen');
});

test('both search boxes have an × that clears them', async ({ page }) => {
  await page.goto(WEB);
  const filter = page.getByPlaceholder('Filter streams');
  const sidebar = page.locator('.sidebar-tools');
  await expect(sidebar.getByRole('button', { name: 'Clear' })).toHaveCount(0);
  await filter.fill('zzz-no-such-stream');
  await expect(page.locator('button.stream-open')).toHaveCount(0);
  await sidebar.getByRole('button', { name: 'Clear' }).click();
  await expect(filter).toHaveValue('');
  await expect(filter).toBeFocused();
  await expect(page.locator('button.stream-open').first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const box = page.getByRole('textbox', { name: 'Search everything' });
  await box.fill('kickoff');
  const dlg = page.getByRole('dialog', { name: 'Search everything' });
  await dlg.getByRole('button', { name: 'Clear' }).click();
  await expect(box).toHaveValue('');
  await expect(box).toBeFocused();
});

test('the Filter streams box is a plain box (no drop shadow from the search pop-up)', async ({ page }) => {
  await page.goto(WEB);
  const f = page.getByPlaceholder('Filter streams');
  expect(await f.evaluate((e) => getComputedStyle(e).boxShadow)).toBe('none');
  await page.locator('.sidebar-tools').screenshot({ path: 'qa/results/filter-box.png' });
  await page.keyboard.press('ControlOrMeta+k');
  expect(await page.getByRole('dialog', { name: 'Search everything' }).evaluate((e) => getComputedStyle(e).boxShadow)).not.toBe('none');
});
