import AxeBuilder from '@axe-core/playwright';
import { test, expect, freshApp, api, stream, watchPage, WEB } from './helpers';

freshApp();

test.beforeAll(async () => {
  await api.waitPending(['ticket_create', 'email_reply']);
});

test('no console errors, page errors or failed requests while touring the app', async ({ page }) => {
  const problems = watchPage(page);
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  for (const tab of await page.locator('.tabbar button').all()) await tab.click();
  await page.getByRole('button', { name: /settings/i }).first().click();
  for (const b of await page.locator('nav button, aside button, .settings-nav button').all()) await b.click().catch(() => undefined);
  await page.getByRole('button', { name: /dashboard/i }).first().click();
  expect(problems, problems.join('\n')).toEqual([]);
});

test('accessibility: no serious or critical axe violations on dashboard and settings', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  await expect(page.locator('.draft').first()).toBeVisible();
  const dash = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  await page.getByRole('button', { name: /settings/i }).first().click();
  const sett = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = [...dash.violations.map((v) => ({ ...v, where: 'dashboard' })), ...sett.violations.map((v) => ({ ...v, where: 'settings' }))].filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  expect(serious.map((v) => `[${v.where}] ${v.impact}: ${v.id} - ${v.help} (${v.nodes.length} nodes, e.g. ${v.nodes[0]?.target.join(' ')}) ${v.nodes[0]?.any?.[0]?.message ?? ''}`)).toEqual([]);
});

test('layout does not overflow horizontally at laptop and small-window sizes', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  for (const [w, h] of [[1440, 900], [1100, 700], [900, 700]]) {
    await page.setViewportSize({ width: w, height: h });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect.soft(over, `horizontal overflow at ${w}x${h}`).toBeLessThanOrEqual(0);
    await expect.soft(page.locator('.draft').first(), `drafts visible at ${w}x${h}`).toBeVisible();
  }
});

test('draft fields are labelled, editable in place and survive "Save edits" + reload', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const email = page.locator('.draft.kind-email_reply');
  const subject = email.getByLabel('Subject');
  await subject.fill('QA saved subject');
  await email.getByRole('button', { name: /save edits/i }).click();
  await page.reload();
  await stream(page, /contractor access/i).click();
  await expect(page.locator('.draft.kind-email_reply').getByLabel('Subject')).toHaveValue('QA saved subject');
  await expect(page.locator('.draft.kind-email_reply .chip', { hasText: /edited/i })).toBeVisible();
});

test('recipient list fields accept typed comma-separated addresses', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const cc = page.locator('.draft.kind-email_reply').getByLabel(/^Cc/);
  await cc.click();
  await page.keyboard.press('End');
  await page.keyboard.type(', one@example.com, two@example.com', { delay: 10 });
  await expect(cc).toHaveValue(/, one@example\.com, two@example\.com$/);
});

test('keyboard: draft actions are reachable and have accessible names', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const unnamed = await page.$$eval('button, a[href], input, textarea, select', (els) =>
    els
      .filter((e) => !(e as HTMLElement).hidden)
      .filter((e) => {
        const el = e as HTMLInputElement;
        const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent?.trim() || (el.labels && el.labels.length > 0) || el.getAttribute('placeholder');
        return !label;
      })
      .map((e) => e.outerHTML.slice(0, 120)),
  );
  expect(unnamed, 'controls without an accessible name').toEqual([]);
  await page.locator('.draft button', { hasText: /approve/i }).first().focus();
  await expect(page.locator('.draft button:focus')).toBeVisible();
});
