import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();

test.beforeAll(async () => {
  await api.waitPending(['ticket_create', 'email_reply']);
});

test('the hand-off panel has a task box whose text goes at the top of BRIEF.md', async ({ page }) => {
  const folder = path.join(os.homedir(), `.wc-qa-handoff-${Date.now()}`);
  try {
    await page.goto(WEB);
    await stream(page, /contractor access/i).click();
    await page.locator('.tabbar [role=tab]', { hasText: 'Overview' }).click();
    await page.getByRole('button', { name: 'Hand off to Claude Code' }).click();
    await expect(page.locator('.handoff-form')).toContainText(/editing a Google Sheet/i);
    await page.getByLabel('Project folder').fill(folder);
    const terminal = page.getByRole('checkbox', { name: /open in terminal/i });
    if (await terminal.count()) await terminal.uncheck(); // never open a real Terminal from a test
    await page.getByLabel('What should Claude Code do?').fill('Set row 12 to Approved in the linked sheet. Touch nothing else.');
    await page.getByRole('button', { name: /^hand off$/i }).click();
    await expect(page.getByRole('button', { name: /hand off again/i })).toBeVisible();
    const brief = fs.readFileSync(path.join(folder, 'BRIEF.md'), 'utf8');
    expect(brief.indexOf('## Task')).toBeGreaterThan(-1);
    expect(brief.indexOf('Set row 12 to Approved')).toBeLessThan(brief.indexOf('## Overview'));
    expect(brief).toMatch(/Files edited/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
