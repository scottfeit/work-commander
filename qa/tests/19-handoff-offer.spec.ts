import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();

test.beforeAll(async () => {
  await api.waitPending(['ticket_create', 'email_reply']);
});
test.afterAll(() => fs.rmSync(path.join(os.homedir(), '.wc-qa-handoffs'), { recursive: true, force: true }));

const ask = async (page: import('@playwright/test').Page) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  await page.getByRole('textbox', { name: /message claude/i }).fill('HANDOFF-OFFER-TEST please');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const bubble = page.locator('.bubble.handoff-offer');
  await expect(bubble).toBeVisible();
  return bubble;
};

test('One click each: draft "I\'m looking into it" first, then hand off to Claude Code with Claude\'s task', async ({ page }) => {
  const bubble = await ask(page);
  await expect(bubble.getByRole('button', { name: /looking into it/i })).toBeVisible();
  await expect(bubble.getByRole('button', { name: 'Hand off to Claude Code' })).toBeVisible();

  await bubble.getByRole('button', { name: /looking into it/i }).click();
  // (a new reply to the same person replaces the older pending draft, so look for the text, not a count)
  await expect.poll(async () => (await api.pending()).some((d: any) => /looking into it/i.test(JSON.stringify(d.payload))), { timeout: 20_000 }).toBe(true);
  await expect(bubble.getByRole('button', { name: /looking into it/i })).toHaveCount(0);
  expect(fs.existsSync(path.join(os.homedir(), '.wc-qa-handoffs'))).toBe(false); // nothing handed off yet

  await bubble.getByRole('button', { name: 'Hand off to Claude Code' }).click();
  await expect(bubble.getByText(/Handed off to Claude Code/)).toBeVisible();
  await expect(bubble.getByRole('button')).toHaveCount(0);
  await expect(page.getByText(/Handed off to Claude Code: .*BRIEF\.md/)).toBeVisible();
  const root = path.join(os.homedir(), '.wc-qa-handoffs');
  const brief = fs.readFileSync(path.join(root, fs.readdirSync(root)[0], 'BRIEF.md'), 'utf8');
  expect(brief).toContain('Set row 12 to Approved in the linked sheet');
});

test('Dismiss removes the buttons', async ({ page }) => {
  const bubble = await ask(page);
  await bubble.getByRole('button', { name: 'Dismiss' }).click();
  await expect(bubble.getByRole('button', { name: 'Hand off to Claude Code' })).toHaveCount(0);
  await expect(bubble.getByText('Dismissed')).toBeVisible();
});

test('Work items are centered in their pane', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  await page.locator('.tabbar [role=tab]').nth(1).click();
  const view = page.locator('.item-view').first();
  await expect(view).toBeVisible();
  const [box, pane] = await Promise.all([view.boundingBox(), page.locator('.main').boundingBox()]);
  const left = box!.x - pane!.x;
  const right = pane!.x + pane!.width - (box!.x + box!.width);
  expect(Math.abs(left - right)).toBeLessThan(4);
});
