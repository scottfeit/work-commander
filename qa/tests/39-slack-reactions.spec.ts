import path from 'node:path';
import { test, expect, freshApp, api, stream, demoDataDir, WEB } from './helpers';

freshApp();

test('react to Slack messages: existing reactions toggle, the quick five on hover, the full picker with search and workspace emoji', async ({ page }) => {
  const sid = (await api.post('/api/streams', { title: 'Reactions stream', summary: '' })).json.id;
  const msgs = [
    { id: '1700000000.000100', author: { name: 'Dana', slackUserId: 'UDANA' }, text: 'Deploy is done', at: new Date().toISOString(), reactions: [{ name: 'tada', count: 2, mine: false }] },
    { id: '1700000000.000200', author: { name: 'Lee', slackUserId: 'ULEE' }, text: 'Can you check the logs?', at: new Date().toISOString() },
  ];
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run('sr1', sid, 'slack', 'slack_thread', 'C0DEPLOY1:1700000000.000100', '#deploys: Deploy is done', null, JSON.stringify({ messages: msgs, slack: { channel: 'C0DEPLOY1', threadTs: '1700000000.000100' } }), new Date().toISOString());
  db.close();
  const item = async () => (await api.get('/api/items/sr1')).json;

  await page.goto(WEB);
  // opening the Slack item brings its reactions up to date with Slack (one call)
  const sync = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/items/sr1/reactions/sync'));
  await stream(page, /reactions stream/i).click();
  await sync;
  const first = page.locator('.top-pane .msg').nth(0);
  const tada = first.getByRole('button', { name: /^:tada: 2/ });
  await expect(tada).toContainText('🎉');
  // add mine to the existing one, then take it back
  await tada.click();
  await expect.poll(async () => (await item()).data.messages[0].reactions).toEqual([{ name: 'tada', count: 3, mine: true }]);
  await expect(first.getByRole('button', { name: /^:tada: 3, including you/ })).toHaveAttribute('aria-pressed', 'true');
  await first.getByRole('button', { name: /^:tada: 3/ }).click();
  await expect.poll(async () => (await item()).data.messages[0].reactions).toEqual([{ name: 'tada', count: 2, mine: false }]);

  // the quick five show on hover
  const second = page.locator('.top-pane .msg').nth(1);
  await second.hover();
  await expect(second.getByRole('button', { name: 'React :eyes:' })).toBeVisible();
  await second.getByRole('button', { name: 'React :eyes:' }).click();
  await expect.poll(async () => (await item()).data.messages[1].reactions).toEqual([{ name: 'eyes', count: 1, mine: true }]);

  // the full picker: search, and the workspace's own emoji
  await second.getByRole('button', { name: 'Add a reaction' }).click();
  const picker = page.getByRole('dialog', { name: 'React with an emoji' });
  await expect(picker).toContainText('Your workspace');
  await expect(picker.getByRole('button', { name: ':partyparrot:' })).toBeVisible();
  await page.screenshot({ path: 'qa/results/emoji-picker.png' });
  await picker.getByLabel('Search emoji').fill('rocket');
  await picker.getByRole('button', { name: ':rocket:' }).click();
  await expect(picker).toHaveCount(0);
  await expect.poll(async () => (await item()).data.messages[1].reactions.map((r: any) => r.name)).toEqual(['eyes', 'rocket']);
  await page.locator('.top-pane').screenshot({ path: 'qa/results/slack-reactions.png' });
});

test('Settings → Slack: choose the five quick reactions', async ({ page }) => {
  await page.goto(`${WEB}/settings?section=slack`);
  const slot = page.getByRole('button', { name: /^Quick reaction 1:/ });
  await expect(slot).toHaveAttribute('aria-label', 'Quick reaction 1: :+1:');
  await slot.click();
  const picker = page.getByRole('dialog', { name: 'Quick reaction 1' });
  await picker.getByLabel('Search emoji').fill('fire');
  await picker.getByRole('button', { name: ':fire:' }).click();
  await expect(slot).toHaveAttribute('aria-label', 'Quick reaction 1: :fire:');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(async () => (await api.get('/api/settings')).json.slack.quickReactions).toEqual(['fire', 'white_check_mark', 'eyes', 'pray', 'tada']);
});
