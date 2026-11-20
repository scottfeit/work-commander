import { test, expect, freshApp, stream, WEB } from './helpers';

freshApp();

test('the selected work stream stands out: even 2px accent border, tinted background', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const sel = page.locator('.sidebar .stream.active');
  const other = page.locator('.sidebar .stream:not(.active):not(.general)').first();
  const [a, b] = await Promise.all([sel.evaluate((e) => getComputedStyle(e).backgroundColor), other.evaluate((e) => getComputedStyle(e).backgroundColor)]);
  expect(a).not.toBe(b);
  // an even 2px accent border (1px border + 1px inset ring), the same on every side
  const edge = await sel.evaluate((e) => {
    const c = getComputedStyle(e);
    return { widths: [c.borderTopWidth, c.borderRightWidth, c.borderBottomWidth, c.borderLeftWidth], shadow: c.boxShadow };
  });
  expect(new Set(edge.widths).size).toBe(1);
  expect(edge.shadow).toMatch(/0px 0px 0px 1px inset/); // the same 1px ring on every side
  await page.locator('.sidebar').screenshot({ path: 'qa/results/selected-stream.png' });
});

test('pop-up messages close with their × or a click anywhere on them', async ({ page }) => {
  const { api } = await import('./helpers');
  const a = (await api.post('/api/streams', { title: 'Toast stream', summary: '' })).json.id;
  await page.goto(WEB);
  const toast = page.locator('.toast');
  await api.call('PATCH', `/api/streams/${a}`, { title: 'Toast stream 2' });
  await page.locator('.brand').getByRole('button', { name: /^Undo/ }).click();
  await expect(toast).toHaveCount(1);
  await page.locator('.toasts').screenshot({ path: 'qa/results/toast.png' });
  await toast.getByRole('button', { name: 'Close' }).click();
  await expect(toast).toHaveCount(0);
  await api.call('PATCH', `/api/streams/${a}`, { title: 'Toast stream 3' });
  await page.locator('.brand').getByRole('button', { name: /^Undo/ }).click();
  await expect(toast).toHaveCount(1);
  await toast.locator('strong').click();
  await expect(toast).toHaveCount(0);
});

test('a closed work stream has a Reopen button on its card', async ({ page }) => {
  const { api } = await import('./helpers');
  const id = (await api.post('/api/streams', { title: 'Reopen card stream', summary: '' })).json.id;
  await api.call('PATCH', `/api/streams/${id}`, { status: 'closed' });
  await page.goto(WEB);
  await page.locator('.sidebar').getByRole('checkbox', { name: /Show closed/ }).check();
  await stream(page, /reopen card stream/i).click();
  const card = page.locator('.sidebar .stream.active');
  await expect(card.getByRole('button', { name: 'Close stream' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Reopen stream' }).click();
  await expect.poll(async () => (await api.get('/api/streams?includeClosed=1')).json.find((s: any) => s.id === id).status).toBe('open');
  await expect(page.locator('.sidebar .stream.active').getByRole('button', { name: 'Close stream' })).toBeVisible();
});

test('a stream reopened by new activity shows a "Reopened" chip', async ({ page }) => {
  const { api, demoDataDir } = await import('./helpers');
  const path = await import('node:path');
  const id = (await api.post('/api/streams', { title: 'Reopened chip stream', summary: '' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('update streams set reopened_at = ? where id = ?').run(new Date().toISOString(), id);
  db.close();
  await page.goto(WEB);
  const card = page.locator('.sidebar .stream', { hasText: 'Reopened chip stream' });
  await expect(card.locator('.reopened-chip')).toHaveText('Reopened');
  await card.screenshot({ path: 'qa/results/reopened-chip.png' });
  await api.call('PATCH', `/api/streams/${id}`, { pending: true }); // your next move clears it
  await expect(page.locator('.sidebar .stream', { hasText: 'Reopened chip stream' }).locator('.reopened-chip')).toHaveCount(0);
});

test('each stream card shows how many work items it holds, in the corner of its tool icon', async ({ page }) => {
  const { api: a, demoDataDir } = await import('./helpers');
  const path = await import('node:path');
  const id = (await a.post('/api/streams', { title: 'Count badge stream', summary: '' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  for (const n of [1, 2, 3]) db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run(`cnt${n}`, id, 'gmail', 'email_thread', `cnt-${n}`, `Thread ${n}`, null, '{"messages":[]}', new Date().toISOString());
  db.close();
  await page.goto(WEB);
  const card = page.locator('.sidebar .stream', { hasText: 'Count badge stream' });
  await expect(card.locator('.src-count')).toHaveText('3');
  await expect(card.locator('.src-count')).toHaveAttribute('aria-label', '3 work items');
  await card.locator('.stream-head').screenshot({ path: 'qa/results/item-count.png' });
});

test('a Slack DM can be marked read or unread in Slack itself; a thread cannot', async ({ page }) => {
  const { api: a, demoDataDir } = await import('./helpers');
  const path = await import('node:path');
  const id = (await a.post('/api/streams', { title: 'Slack read stream', summary: '' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  const msg = (ts: string) => ({ id: ts, author: { name: 'Priya' }, text: `hello ${ts}`, at: new Date().toISOString() });
  const put = (iid: string, ext: string, msgs: any[], when: string) =>
    db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run(iid, id, 'slack', 'slack_thread', ext, iid, null, JSON.stringify({ messages: msgs, slack: { channel: ext.split(':')[0], threadTs: msgs[0].id } }), when);
  put('sr-thread', 'C0THREAD1:100.000001', [msg('100.000001'), msg('100.000002')], '2020-01-01T00:00:00Z');
  put('sr-dm', 'D0READ123:dm', [msg('200.000001')], new Date().toISOString());
  db.close();
  await page.goto(WEB);
  await stream(page, /Slack read stream/).click();
  await page.getByText('sr-dm', { exact: true }).first().click();
  const group = page.getByRole('group', { name: 'Slack' });
  await group.getByRole('button', { name: 'Mark read in Slack' }).click();
  await expect(group.getByRole('button', { name: 'Mark unread in Slack' })).toBeVisible();
  expect((await a.get('/api/items/sr-dm/slack-read')).json).toEqual({ unread: false });
  await group.getByRole('button', { name: 'Mark unread in Slack' }).click();
  await expect(group.getByRole('button', { name: 'Mark read in Slack' })).toBeVisible();
  await page.locator('.top-pane .item-head').screenshot({ path: 'qa/results/slack-read.png' });
  await page.getByText('sr-thread', { exact: true }).first().click();
  await expect(page.getByRole('group', { name: 'Slack' })).toHaveCount(0);
  expect((await a.get('/api/items/sr-thread/slack-read')).status).toBe(400);
});

test('marking the open stream Pending while Pending is hidden opens the next stream', async ({ page }) => {
  const { api: a } = await import('./helpers');
  await a.post('/api/streams', { title: 'Next after pending', summary: '' });
  await page.goto(WEB);
  await page.locator('.sidebar').getByRole('checkbox', { name: /Show pending/ }).uncheck();
  await stream(page, /contractor access/i).click();
  // the next one in the Open list as shown (or the one before, when it's last)
  const titles = await page.locator('.sidebar .stream.open:not(.general):not(.skipped-tile):not(.pending) .stream-title').allTextContents();
  const i = titles.findIndex((t) => /contractor access/i.test(t));
  const expected = titles[i + 1] ?? titles[i - 1];
  await page.locator('.sidebar .stream.active').getByRole('button', { name: 'Mark pending' }).click();
  await expect(page.locator('.sidebar .stream.active .stream-title')).toHaveText(expected);
  await expect(page.locator('.sidebar .stream', { hasText: /contractor access/i })).toHaveCount(0);
  // with Pending shown, it stays on the stream you marked
  await page.locator('.sidebar').getByRole('checkbox', { name: /Show pending/ }).check();
  await page.locator('.sidebar .stream.active').getByRole('button', { name: 'Mark pending' }).click();
  await expect(page.locator('.sidebar .stream.active .stream-title')).toHaveText(expected);
});
