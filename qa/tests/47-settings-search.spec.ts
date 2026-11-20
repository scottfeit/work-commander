import { test, expect, freshApp, WEB } from './helpers';

freshApp();

test('Settings search finds rows across sections; Esc clears it', async ({ page }) => {
  await page.goto(`${WEB}/settings`);
  const box = page.getByRole('textbox', { name: 'Search settings' });
  await box.fill('message order');
  const visible = page.locator('.settings-body .srow:visible');
  // every word, anywhere in a row's name or explanation
  await expect(visible.filter({ hasText: 'Message order' })).toHaveCount(1);
  await expect(page.locator('.srow', { hasText: 'Closing work streams' })).toBeHidden();
  expect(await visible.count()).toBeLessThan(4);
  await page.locator('.settings-body').screenshot({ path: 'qa/results/settings-search.png' });
  // words anywhere in the label or its explanation, from any section
  await box.fill('polling');
  expect(await visible.count()).toBeGreaterThan(1);
  await box.press('Escape');
  await expect(box).toHaveValue('');
  await expect(page.locator('.settings-body h2', { hasText: 'Display' })).toHaveCount(0); // back to the one section
});

test('a changed setting gets a dot and Reset; "Show only changed settings" lists just those', async ({ page }) => {
  await page.goto(`${WEB}/settings?section=display`);
  const row = page.locator('.srow', { hasText: 'Closing work streams' });
  await expect(row.locator('.changed-dot')).toHaveCount(0);
  await row.getByRole('checkbox').uncheck();
  await expect(row.locator('.changed-dot')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Show only changed settings' }).check();
  const shown = await page.locator('.settings-body .srow:visible .srow-title').allTextContents();
  expect(shown.some((t) => t.includes('Closing work streams'))).toBe(true);
  expect(shown.some((t) => t.includes('Message order'))).toBe(false);
  await page.locator('.settings-body').screenshot({ path: 'qa/results/settings-changed.png' });
  await page.locator('.srow', { hasText: 'Closing work streams' }).getByRole('button', { name: 'Reset' }).click();
  await expect(page.locator('.srow', { hasText: 'Closing work streams' })).toHaveCount(0); // back to default: no longer listed
  await page.getByRole('checkbox', { name: 'Show only changed settings' }).uncheck();
  await expect(page.locator('.srow', { hasText: 'Closing work streams' }).getByRole('checkbox')).toBeChecked();
});

test('a connection problem shows a banner (only then), with a way to fix it', async ({ page }) => {
  await page.goto(WEB);
  await expect(page.locator('.conn-banner')).toHaveCount(0); // all well: nothing shown
  await page.route('**/api/integrations/status', (r) => r.fulfill({ json: { slack: { ok: false, message: 'Slack poll failed: token_expired', at: new Date().toISOString() }, google: { ok: true, message: 'ok', at: new Date().toISOString() } } }));
  await page.reload();
  const b = page.locator('.conn-banner');
  await expect(b).toHaveCount(1);
  await expect(b).toContainText('Slack needs attention: Slack poll failed: token_expired');
  await page.locator('.banners').screenshot({ path: 'qa/results/conn-banner.png' });
  await b.getByRole('button', { name: 'Dismiss the Slack alert' }).click();
  await expect(b).toHaveCount(0);
  await page.reload();
  await page.locator('.conn-banner').getByRole('button', { name: 'Fix in Settings' }).click();
  await expect(page).toHaveURL(/\/settings\?section=slack/);
  await expect(page.locator('.settings-body h2', { hasText: 'Slack' })).toBeVisible();
});

test('keyboard focus shows a clear ring on buttons (and not on mouse clicks)', async ({ page }) => {
  await page.goto(WEB);
  const btn = page.getByRole('button', { name: 'Settings' });
  await btn.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => { const c = getComputedStyle(document.activeElement!); return `${c.outlineStyle} ${c.outlineWidth}`; });
  expect(ring).toBe('solid 2px');
  await page.locator('.sidebar').screenshot({ path: 'qa/results/focus-ring.png', clip: { x: 0, y: 0, width: 300, height: 80 } });
  await page.getByRole('button', { name: 'All open work' }).click();
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe('none');
});

test('with reduced motion on in the system, nothing animates', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(WEB);
  const slow = await page.evaluate(() =>
    [...document.querySelectorAll('*')].filter((e) => {
      const c = getComputedStyle(e);
      const secs = (v: string) => Math.max(...v.split(',').map((x) => parseFloat(x) * (x.trim().endsWith('ms') ? 0.001 : 1)));
      return secs(c.transitionDuration) > 0.01 || (c.animationName !== 'none' && secs(c.animationDuration) > 0.01);
    }).length,
  );
  expect(slow).toBe(0);
  await ctx.close();
});
