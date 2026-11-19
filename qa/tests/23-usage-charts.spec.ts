import path from 'node:path';
import { test, expect, freshApp, api, stream, demoDataDir, WEB } from './helpers';

freshApp();

let streamId = '';
const day = (ago: number) => {
  const d = new Date(Date.now() - ago * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test.beforeAll(async () => {
  streamId = (await api.post('/api/streams', { title: 'Usage chart stream', summary: 'Seeded usage' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  const add = db.prepare('insert into usage_daily (day, kind, model, stream_id, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) values (?,?,?,?,?,?,?,?,?,?)');
  const rows: [number, string, string, number][] = [
    [0, 'triage', streamId, 0.04],
    [0, 'agentDraft', streamId, 0.31],
    [0, 'agentChat', streamId, 0.12],
    [0, 'agentReview', streamId, 0.07],
    [0, 'overview', streamId, 0.01],
    [0, 'mcpIngest', '', 0.4],
    [1, 'agentHandoff', streamId, 0.09],
    [1, 'claudeCode', streamId, 0.5], // Claude Code's own work on the hand-off
    [1, 'mcpIngest', '', 0.55],
    [2, 'agent', '', 0.2],
  ];
  for (const [ago, kind, sid, cost] of rows) add.run(day(ago), kind, 'claude-haiku-5-5', sid, 3, 1000, 200, 5000, 100, cost);
  db.close();
});

test("A work stream's Overview shows its estimated cost by category", async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /usage chart stream/i).click();
  const legend = page.locator('.usage-pie-legend');
  await expect(legend).toBeVisible();
  await expect(legend.locator('tbody tr td:first-child')).toHaveText(['Triage', 'Drafting messages', 'Claude Code hand-offs', 'Claude Code (hand-off work)', 'Chatting with you', 'Keeping streams up to date', 'Overview refreshes']);
  await expect(legend.locator('tfoot')).toContainText('$1.14');
  await expect(page.locator('.usage-pie svg path')).toHaveCount(7);
  // shown in the hand-off hue, hatched
  await expect(page.locator('.usage-pie svg path.c-claudeCode')).toHaveCount(1);
  await page.locator('.stream-usage').screenshot({ path: 'qa/results/usage-pie.png' });
});

test('Settings → Usage: the by-day bars are split by the same categories', async ({ page }) => {
  await page.goto(`${WEB}/settings?section=usage`);
  const bars = page.locator('.usage-day');
  await expect(bars).toHaveCount(3);
  await expect(bars.first().locator('.usage-bar i')).toHaveCount(6); // today: triage, reading, drafting, chat, review, overview
  await expect(page.locator('.usage-legend')).toContainText('Reading Slack and other sources');
  await expect(page.locator('.usage-legend')).toContainText('Other');
  await expect(page.locator('.usage-legend')).toContainText('Claude Code (hand-off work)');
  await page.locator('section', { has: page.getByRole('heading', { name: 'Usage', exact: true }) }).screenshot({ path: 'qa/results/usage-settings.png' });
});
