import path from 'node:path';
import { test, expect, freshApp, api, demoDataDir, stream, WEB } from './helpers';

freshApp();

test('Slack replies: "Reply in thread" defaults to the thread when the talk is in one, and follows the message you tick', async ({ page }) => {
  const sid = (await api.post('/api/streams', { title: 'Thread reply stream', summary: '' })).json.id;
  const t = (m: number) => new Date(Date.now() - (60 - m) * 60_000).toISOString();
  const msgs = [
    { id: '100.000001', author: { name: 'Lee Wong' }, text: 'plain message first', at: t(1) },
    { id: '100.000002', author: { name: 'Priya Shah' }, text: 'starting a thread here', at: t(2), threadTs: '100.000002' },
    { id: '100.000003', author: { name: 'Lee Wong' }, text: 'reply inside the thread', at: t(3), threadTs: '100.000002' },
  ];
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run('thr1', sid, 'slack', 'slack_thread', 'D0THREAD:dm', 'Thread DM', null, JSON.stringify({ messages: msgs, slack: { channel: 'D0THREAD', threadTs: '100.000001' } }), t(3));
  db.close();
  await page.goto(WEB);
  await stream(page, /Thread reply stream/).click();
  await page.getByText('Thread DM', { exact: true }).first().click();
  await page.locator('.top-pane .item-head').getByRole('button', { name: 'Quick reply' }).click();
  const draft = page.locator('.draft', { hasText: 'Quick reply' });
  const box = draft.getByRole('checkbox', { name: 'Reply in thread' });
  await expect(box).toBeChecked(); // the latest message is in a thread
  await expect(draft.locator('.thread-toggle')).toContainText('In the thread of Priya Shah: “starting a thread here”');
  await draft.locator('.thread-toggle').screenshot({ path: 'qa/results/thread-toggle.png' });
  await box.uncheck();
  await expect(draft.locator('.thread-toggle')).toContainText('Posts in the conversation');
  // tick the first (plain) message, then check: the reply goes in a new thread under it
  await page.getByRole('checkbox', { name: 'Select message from Lee Wong' }).first().check();
  await box.check();
  await expect(draft.locator('.thread-toggle')).toContainText('In the thread of Lee Wong: “plain message first”');
  await draft.getByLabel('Message').fill('On it');
  await draft.getByRole('button', { name: 'Approve & send' }).click();
  const p = (await api.proposals()).find((x: any) => x.payload.quick && x.payload.channel === 'D0THREAD')!;
  const done = (await api.waitStatus(p.id, 'executed')) as any;
  expect(done.payload.thread_ts).toBe('100.000001');
});

test('a reply in a DM with no thread starts unchecked (posts in the conversation)', async ({ page }) => {
  const sid = (await api.post('/api/streams', { title: 'Flat DM stream', summary: '' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run('flat1', sid, 'slack', 'slack_thread', 'D0FLAT:dm', 'Flat DM', null, JSON.stringify({ messages: [{ id: '200.000001', author: { name: 'Lee Wong' }, text: 'hello', at: new Date().toISOString() }], slack: { channel: 'D0FLAT', threadTs: '200.000001' } }), new Date().toISOString());
  db.close();
  await page.goto(WEB);
  await stream(page, /Flat DM stream/).click();
  await page.getByText('Flat DM', { exact: true }).first().click();
  await page.locator('.top-pane .item-head').getByRole('button', { name: 'Quick reply' }).click();
  const draft = page.locator('.draft', { hasText: 'Quick reply' });
  await expect(draft.getByRole('checkbox', { name: 'Reply in thread' })).not.toBeChecked();
  await expect(draft.locator('.thread-toggle')).toContainText('Posts in the conversation');
});

test('ticking a message with no thread yet starts a new thread under it, even in a conversation stored as a thread', async ({ page }) => {
  const sid = (await api.post('/api/streams', { title: 'Group DM stream', summary: '' })).json.id;
  const t = (m: number) => new Date(Date.now() - (60 - m) * 60_000).toISOString();
  // a group DM (C id) that came in live: stored like a thread, with an older thread and a later plain message
  const msgs = [
    { id: '300.000001', author: { name: 'Priya Shah' }, text: 'old thread starts', at: t(1), threadTs: '300.000001' },
    { id: '300.000002', author: { name: 'Lee Wong' }, text: 'old thread reply', at: t(2), threadTs: '300.000001' },
    { id: '300.000003', author: { name: 'Marco Diaz' }, text: 'brand new topic', at: t(3) },
  ];
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run('gdm1', sid, 'slack', 'slack_thread', 'C0GROUP:300.000001', 'Group DM', null, JSON.stringify({ messages: msgs, slack: { channel: 'C0GROUP', threadTs: '300.000001' } }), t(3));
  db.close();
  await page.goto(WEB);
  await stream(page, /Group DM stream/).click();
  await page.getByText('Group DM', { exact: true }).first().click();
  await page.locator('.top-pane .item-head').getByRole('button', { name: 'Quick reply' }).click();
  const draft = page.locator('.draft', { hasText: 'Quick reply' });
  await expect(draft.getByRole('checkbox', { name: 'Reply in thread' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Select message from Marco Diaz' }).check();
  await expect(draft.locator('.thread-toggle')).toContainText('In the thread of Marco Diaz: “brand new topic”');
  // ticking a message already in a thread goes to that thread
  await page.getByRole('checkbox', { name: 'Select message from Marco Diaz' }).uncheck();
  await page.getByRole('checkbox', { name: 'Select message from Lee Wong' }).check();
  await expect(draft.locator('.thread-toggle')).toContainText('In the thread of Priya Shah: “old thread starts”');
  await page.getByRole('checkbox', { name: 'Select message from Lee Wong' }).uncheck();
  await page.getByRole('checkbox', { name: 'Select message from Marco Diaz' }).check();
  await draft.getByLabel('Message').fill('Starting a thread');
  await draft.getByRole('button', { name: 'Approve & send' }).click();
  const p = (await api.proposals()).find((x: any) => x.payload.quick && x.payload.channel === 'C0GROUP')!;
  const done = (await api.waitStatus(p.id, 'executed')) as any;
  expect(done.payload.thread_ts).toBe('300.000003');
});
