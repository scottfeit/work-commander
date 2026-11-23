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
    ['propC', 'Parking permit renewal'],
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
  // Decline and Decline & mute are outlined buttons, like Allow
  for (const name of ['Decline', 'Decline & mute']) {
    const border = await t.getByRole('button', { name, exact: true }).evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(border).not.toBe('rgba(0, 0, 0, 0)');
  }
  await t.getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(tile(page, /Offsite catering order/)).toHaveCount(0);
  expect((await api.streams()).some((s) => s.title === 'Offsite catering order')).toBe(false);
});

test('Decline & mute hides it for good; Show declined lists it as muted', async ({ page }) => {
  await page.goto(WEB);
  await tile(page, /Parking permit renewal/).getByRole('button', { name: 'Decline & mute' }).click();
  await expect(tile(page, /Parking permit renewal/)).toHaveCount(0);
  const item = (await api.get('/api/items/skipped?dismissed=1')).json.find((i: any) => i.id === 'propC');
  expect(item).toMatchObject({ dismissed: true, muted: true });
  await page.getByRole('checkbox', { name: 'Show declined' }).check();
  await expect(tile(page, /Parking permit renewal/).getByText('declined · muted')).toBeVisible();
});

test('Skipped ("?") items have Decline & mute too', async ({ page }) => {
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  const now = new Date().toISOString();
  db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run('skipQ', null, 'gmail', 'email_thread', 'ext-skipQ', 'Your trial has started', null, JSON.stringify({ messages: [{ id: 'm-skipQ', author: { name: 'Vendor' }, text: 'Welcome!', at: now }] }), now);
  db.close();
  await page.goto(WEB);
  const t = page.locator('.skipped-tile:not(.proposed-tile)', { hasText: /Your trial has started/ });
  await expect(t.getByRole('button', { name: 'Decline', exact: true })).toBeVisible();
  // Accept, Decline, the bell (decline & mute) and the trash can (delete & mute) sit on one line
  await expect(t.getByRole('button', { name: 'Delete & mute' })).toBeVisible();
  const ys = await t.locator('.stream-meta .btn').evaluateAll((bs) => bs.map((b) => Math.round(b.getBoundingClientRect().top)));
  expect(ys).toHaveLength(4);
  expect(new Set(ys).size).toBe(1);
  await t.screenshot({ path: 'qa/results/skipped-tile.png' });
  await t.getByRole('button', { name: 'Decline & mute' }).click();
  await expect(t).toHaveCount(0);
  expect((await api.get('/api/items/skipped?dismissed=1')).json.find((i: any) => i.id === 'skipQ')).toMatchObject({ dismissed: true, muted: true });
});
