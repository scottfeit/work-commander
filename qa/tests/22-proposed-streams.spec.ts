import path from 'node:path';
import { test, expect, freshApp, api, demoDataDir, WEB } from './helpers';

freshApp();

const proposal = (title: string) => ({
  title,
  summary: `Summary of ${title}.`,
  labels: [],
  reason: 'Dana asks for a review',
  at: new Date().toISOString(),
  decision: { relevant: true, reason: 'Dana asks for a review', stream: { action: 'new', streamId: null, title, summary: `Summary of ${title}.`, labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } },
});

test.beforeAll(async () => {
  const settings = (await api.get('/api/settings')).json;
  await api.call('PUT', '/api/settings', { ...settings, triage: { ...settings.triage, newStreams: 'ask' } });
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  const now = new Date().toISOString();
  for (const [id, title] of [
    ['propA', 'Vendor security questionnaire'],
    ['propB', 'Offsite catering order'],
  ])
    db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run(
      id,
      null,
      'gmail',
      'email_thread',
      `ext-${id}`,
      `Re: ${title}`,
      null,
      JSON.stringify({ messages: [{ id: `m-${id}`, author: { name: 'Dana' }, text: 'Can you take a look?', at: now }], proposedStream: proposal(title) }),
      now,
    );
  db.close();
});

const tile = (page: import('@playwright/test').Page, re: RegExp) => page.locator('.proposed-tile', { hasText: re });

test('Settings → Triage offers both modes', async ({ page }) => {
  await page.goto(`${WEB}/settings?section=triage`);
  const select = page.locator('select', { has: page.locator('option', { hasText: 'Ask me first' }) });
  await expect(select).toHaveValue('ask');
  await expect(select.locator('option')).toHaveText(['Create them automatically', 'Ask me first (accept or decline)']);
});

test('A proposed work stream shows in the list; Accept creates it', async ({ page }) => {
  await page.goto(WEB);
  const t = tile(page, /Vendor security questionnaire/);
  await expect(t).toBeVisible();
  await expect(t.getByText('New?')).toBeVisible();
  await t.getByRole('button', { name: 'Accept' }).click();
  await expect(page.locator('.title-input')).toHaveValue('Vendor security questionnaire');
  await expect(tile(page, /Vendor security questionnaire/)).toHaveCount(0);
  expect((await api.streams()).some((s) => s.title === 'Vendor security questionnaire')).toBe(true);
});

test('Decline removes it from the list without creating a stream', async ({ page }) => {
  await page.goto(WEB);
  const t = tile(page, /Offsite catering order/);
  await t.getByRole('button', { name: 'Decline' }).click();
  await expect(tile(page, /Offsite catering order/)).toHaveCount(0);
  expect((await api.streams()).some((s) => s.title === 'Offsite catering order')).toBe(false);
});
