import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();

test.beforeAll(async () => {
  await api.waitPending(['ticket_create', 'email_reply']);
});

test('Quick reply opens a blank pre-addressed draft that stays open across tabs; drafts and streams show tool icons', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();

  // stream tiles carry the icon of the tool that produced the latest update
  await expect(stream(page, /contractor access/i).locator('.src-icon').first()).toBeVisible();

  // open the email tab and press Quick reply
  await page.locator('.tabbar').getByRole('img', { name: 'Gmail' }).click();
  const before = await page.locator('.draft').count();
  await page.getByRole('button', { name: 'Quick reply' }).click();
  const quick = page.locator('.draft', { hasText: /Quick reply/ });
  await expect(quick).toBeVisible();
  await expect(page.locator('.draft')).toHaveCount(before + 1); // next to Claude's draft for the same thread, not replacing it

  // reply-all: addressed, subject filled, message blank and focused; cannot be sent while blank
  await expect(quick.getByLabel('To')).not.toHaveValue('');
  await expect(quick.getByLabel('Subject')).toHaveValue(/^Re: /);
  await expect(quick.getByLabel('Message')).toBeFocused();
  await expect(quick.getByRole('button', { name: /approve & send/i })).toBeDisabled();

  // drafts show the tool's icon instead of its name
  await expect(quick.locator('.draft-head .src-icon')).toBeVisible();
  await expect(quick.locator('.draft-head .sys')).toHaveCount(0);

  // typing enables sending; working in the Overview keeps the draft and the text
  await quick.getByLabel('Message').fill('Quick note from me');
  await expect(quick.getByRole('button', { name: /approve & send/i })).toBeEnabled();
  await page.locator('.overview-pane .summary-input').click();
  await expect(quick).toBeVisible();
  await expect(quick.getByLabel('Message')).toHaveValue('Quick note from me');

  // pressing it again goes to your same draft instead of making another
  await page.locator('.tabbar').getByRole('img', { name: 'Gmail' }).click();
  await page.getByRole('button', { name: 'Quick reply' }).click();
  await expect(page.locator('.draft', { hasText: /Quick reply/ })).toHaveCount(1);
  await expect(page.locator('.draft')).toHaveCount(before + 1);

  // and the text survives a reload (it was saved as you typed)
  await page.waitForTimeout(1200);
  await page.reload();
  await stream(page, /contractor access/i).click();
  await expect(page.locator('.draft', { hasText: /Quick reply/ }).getByLabel('Message')).toHaveValue('Quick note from me');
});

test("Rejecting your own Quick Reply discards it at once (no \"why?\" box); Claude's drafts still ask why", async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  await page.locator('.tabbar').getByRole('img', { name: 'Gmail' }).click();
  await page.getByRole('button', { name: 'Quick reply' }).click();
  const quick = page.locator('.draft', { hasText: /Quick reply/ });
  await expect(quick).toBeVisible();
  await quick.getByRole('button', { name: 'Reject' }).click();
  await expect(quick).toHaveCount(0);
  await expect(page.getByLabel('Why reject this draft?')).toHaveCount(0);

  const claudes = page.locator('.draft').first();
  await claudes.getByRole('button', { name: 'Reject' }).click();
  await expect(claudes.getByLabel('Why reject this draft?')).toBeVisible();
  await claudes.getByRole('button', { name: 'Cancel' }).click();
});
