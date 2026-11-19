import path from 'node:path';
import { test, expect, freshApp, api, stream, demoDataDir, WEB } from './helpers';

freshApp();

test('tick Slack messages (shift-click for a range) and move them to another stream, or out of this one', async ({ page }) => {
  const home = (await api.post('/api/streams', { title: 'Bulk source stream', summary: '' })).json.id;
  const other = (await api.post('/api/streams', { title: 'Bulk target stream', summary: '' })).json.id;
  const t0 = 1_700_000_000;
  const msgs = [1, 2, 3, 4, 5].map((n) => ({ id: `${t0 + n}.000100`, author: { name: `P${n}`, slackUserId: `U${n}` }, text: `message ${n}`, at: new Date((t0 + n) * 1000).toISOString() }));
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run('bulk1', home, 'slack', 'slack_thread', `C0BULK0001:${msgs[0].id}`, '#ops: message 1', null, JSON.stringify({ messages: msgs, slack: { channel: 'C0BULK0001', threadTs: msgs[0].id } }), new Date().toISOString());
  db.close();
  const inStream = async (sid: string) => ((await api.get(`/api/streams/${sid}/items`)).json as any[]).filter((i) => i.source === 'slack').flatMap((i) => i.data.messages.map((m: any) => m.text));

  await page.goto(WEB);
  await stream(page, /bulk source stream/i).click();
  const boxes = page.locator('.top-pane .msg .msg-pick');
  await expect(boxes).toHaveCount(5); // always shown
  await boxes.nth(1).click();
  await boxes.nth(3).click({ modifiers: ['Shift'] }); // 2, 3, 4
  const bar = page.getByRole('toolbar', { name: 'Selected messages' });
  await expect(bar).toContainText('3 selected');
  await expect(page.locator('.top-pane .msg.picked')).toHaveCount(3);
  for (const i of [1, 2, 3]) await expect(boxes.nth(i)).toBeChecked(); // the ticks match
  for (const i of [0, 4]) await expect(boxes.nth(i)).not.toBeChecked();
  await page.locator('.top-pane').screenshot({ path: 'qa/results/slack-bulk.png' });
  await bar.getByLabel('Move selected to').selectOption({ label: 'Bulk target stream' });
  await bar.getByRole('button', { name: 'Move', exact: true }).click();
  await expect.poll(() => inStream(other)).toEqual(['message 2', 'message 3', 'message 4']);
  await expect.poll(() => inStream(home)).toEqual(['message 1', 'message 5']);
  await expect(bar).toHaveCount(0);

  // remove one from the work stream
  await expect(boxes).toHaveCount(2);
  await boxes.nth(1).click();
  await bar.getByRole('button', { name: 'Remove from work stream' }).click();
  await expect.poll(() => inStream(home)).toEqual(['message 1']);
});
