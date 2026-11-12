import { test, expect, freshApp, WEB } from './helpers';

freshApp();

test('Email original: toggle to the HTML as sent, scripts and remote images blocked, back to text', async ({ page }) => {
  await page.goto(WEB);
  await page.getByText('This week in SaaS', { exact: false }).first().click();
  const original = page.getByRole('button', { name: 'Original' });
  await expect(original).toBeVisible();
  await original.click();

  const frame = page.frameLocator('.email-html iframe');
  await expect(frame.getByRole('heading', { name: 'Our top picks this week' })).toBeVisible();
  // scripts never run
  expect(await page.locator('.email-html iframe').evaluate((f: HTMLIFrameElement) => f.contentDocument!.title)).not.toBe('pwned');
  // remote images are held back until asked
  await expect(page.getByText('Remote images are blocked')).toBeVisible();
  await page.getByRole('button', { name: 'Load images' }).click();
  await expect(page.getByText('Remote images are blocked')).toHaveCount(0);
  // links open in a new tab
  await expect(frame.getByRole('link', { name: 'the full list' })).toBeVisible();
  await expect(frame.locator('base')).toHaveAttribute('target', '_blank');

  await page.getByRole('button', { name: 'Text' }).click();
  await expect(page.locator('.email-html')).toHaveCount(0);
  await expect(page.getByText('Our top picks this week…')).toBeVisible();
});

test('Settings → Display → Emails sets the default view; a message can still be flipped', async ({ page }) => {
  await page.goto(WEB + '/settings');
  await page.getByRole('button', { name: 'Display' }).click();
  await page.getByLabel('Emails').selectOption('original');
  await page.getByRole('button', { name: /save changes/i }).click();
  await expect(page.getByText(/settings saved/i)).toBeVisible();

  await page.goto(WEB);
  await page.getByText('This week in SaaS', { exact: false }).first().click();
  await expect(page.locator('.email-html iframe')).toBeVisible(); // opens on the original
  await page.getByRole('button', { name: 'Text' }).click();
  await expect(page.locator('.email-html')).toHaveCount(0);
  await expect(page.getByText('Our top picks this week…')).toBeVisible();
});
