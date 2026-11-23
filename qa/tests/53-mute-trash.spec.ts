import path from 'node:path';
import { test, expect, freshApp, api, demoDataDir, WEB } from './helpers';

freshApp();

const proposal = (title: string) => ({
  title,
  summary: `Summary of ${title}.`,
  labels: [],
  reason: 'Dana asks for a review',
  at: new Date().toISOString(),
  decision: { relevant: true, reason: 'Dana asks', stream: { action: 'new', streamId: null, title, summary: 'S', labels: null }, relatedItemIds: null, updatedSummary: null, notify: null, next: { type: 'none', instruction: '', offerLabel: null } },
});

test.beforeAll(async () => {
  const settings = (await api.get('/api/settings')).json;
  await api.call('PUT', '/api/settings', { ...settings, triage: { ...settings.triage, newStreams: 'ask' } });
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  const now = new Date().toISOString();
  const msg = (id: string) => [{ id, author: { name: 'Dana' }, text: 'Can you take a look?', at: now }];
  const rows: [string, string, string, string, string, object][] = [
    ['trMail', 'gmail', 'email_thread', 'thr-trMail', 'Mail proposal', { messages: msg('m1') }],
    ['trDm', 'slack', 'slack_thread', 'D0TRASH:dm', 'DM proposal', { messages: msg('1.1'), slack: { channel: 'D0TRASH', threadTs: '1.1' } }],
    ['trChan', 'slack', 'slack_thread', 'C0TRASH:2.2', 'Channel proposal', { messages: msg('2.2'), slack: { channel: 'C0TRASH', threadTs: '2.2' } }],
    ['trJira', 'jsm', 'ticket', 'OPS-900', 'OPS-900: Ticket proposal', { ticket: { key: 'OPS-900', summary: 'Ticket proposal', status: 'Open', flavor: 'jsm', comments: [] } }],
  ];
  for (const [id, source, kind, ext, title, data] of rows)
    db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run(id, null, source, kind, ext, title, null, JSON.stringify({ ...data, proposedStream: proposal(title) }), now);
  db.close();
});

const tile = (page: import('@playwright/test').Page, re: RegExp) => page.locator('.proposed-tile', { hasText: re });

test('the bell and the trash can: trash only for email and Slack DMs, never Jira/JSM or channel threads', async ({ page }) => {
  await page.goto(WEB);
  for (const re of [/Mail proposal/, /DM proposal/, /Channel proposal/, /Ticket proposal/]) await expect(tile(page, re).getByRole('button', { name: 'Decline & mute' })).toBeVisible();
  await expect(tile(page, /Mail proposal/).getByRole('button', { name: 'Delete & mute' })).toBeVisible();
  await expect(tile(page, /DM proposal/).getByRole('button', { name: 'Mark read & mute' })).toBeVisible();
  await expect(tile(page, /Channel proposal/).locator('.icon-only')).toHaveCount(1);
  await expect(tile(page, /Ticket proposal/).locator('.icon-only')).toHaveCount(1);
  // the old "Decline & mute" text button is gone: it's an icon now, on one line with the rest
  const t = tile(page, /Mail proposal/);
  await expect(t.getByText('Decline & mute')).toHaveCount(0);
  const ys = await t.locator('.stream-meta .btn').evaluateAll((bs) => bs.map((b) => Math.round(b.getBoundingClientRect().top)));
  expect(new Set(ys).size).toBe(1);
  await t.screenshot({ path: 'qa/results/mute-trash-tile.png' });
});

test('trash on an email: thread to Gmail Trash, declined and muted; Undo brings both back', async ({ page }) => {
  await page.goto(WEB);
  await tile(page, /Mail proposal/).getByRole('button', { name: 'Delete & mute' }).click();
  await expect(tile(page, /Mail proposal/)).toHaveCount(0);
  expect((await api.get('/api/items/trMail/gmail')).json).toMatchObject({ trash: true });
  expect((await api.get('/api/items/skipped?dismissed=1')).json.find((i: any) => i.id === 'trMail')).toMatchObject({ dismissed: true, muted: true });
  await api.post('/api/undo');
  expect((await api.get('/api/items/trMail/gmail')).json).toMatchObject({ trash: false, inbox: true });
  await page.reload();
  await expect(tile(page, /Mail proposal/)).toBeVisible();
});

test('trash on a Slack DM: marked read in Slack, declined and muted', async ({ page }) => {
  await page.goto(WEB);
  expect((await api.get('/api/items/trDm/slack-read')).json.unread).toBe(true);
  await tile(page, /DM proposal/).getByRole('button', { name: 'Mark read & mute' }).click();
  await expect(tile(page, /DM proposal/)).toHaveCount(0);
  expect((await api.get('/api/items/trDm/slack-read')).json.unread).toBe(false);
  expect((await api.get('/api/items/skipped?dismissed=1')).json.find((i: any) => i.id === 'trDm')).toMatchObject({ dismissed: true, muted: true });
  // a channel thread can't be trashed, even by asking the server directly
  expect((await api.post('/api/items/trChan/decline', { mute: true, trash: true })).status).toBe(400);
});
