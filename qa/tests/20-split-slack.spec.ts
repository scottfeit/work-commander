import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();

test.beforeAll(async () => {
  await api.waitPending(['ticket_create', 'email_reply']);
});

test('A Slack message can be moved out of a work stream into a new one', async ({ page }) => {
  // get a Slack conversation with two messages into the stream (Claude's message, then the teammate's reply)
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const kind = (k: string) => page.locator(`.draft.kind-${k}`);
  await kind('ticket_create').getByRole('button', { name: /approve/i }).click();
  await expect(kind('ticket_create')).toHaveCount(0);
  await kind('email_reply').getByRole('button', { name: /approve/i }).click();
  await expect(kind('email_reply')).toHaveCount(0);
  await expect(page.locator('.bubble.question')).toContainText(/work on it/i, { timeout: 20_000 });
  await page.getByRole('button', { name: 'Yes, work on it' }).click();
  const slackDraft = kind('slack_post');
  await expect(slackDraft).toBeVisible({ timeout: 20_000 });
  await slackDraft.getByRole('button', { name: /approve/i }).click();
  const streams = await api.streams();
  const src = streams.find((s) => /contractor access/i.test(s.title));
  const slackOf = async () => ((await api.get(`/api/streams/${src.id}/items`)).json as any[]).find((i) => i.source === 'slack');
  await expect.poll(async () => (await slackOf())?.data.messages.length ?? 0, { timeout: 40_000 }).toBeGreaterThanOrEqual(2);
  const slack = await slackOf();
  const first = slack.data.messages[0];

  await page.reload();
  await stream(page, /contractor access/i).click();
  await page.locator('.tabbar [role=tab]', { hasText: slack.title }).first().click();
  const msg = page.locator('.item-view .msg').first();
  await msg.getByRole('button', { name: 'Move…' }).click();
  const box = page.getByRole('group', { name: 'Move message' });
  await box.getByLabel('Move to').selectOption('__new');
  await box.getByLabel('New work stream title').fill('Split-off topic');
  await box.getByRole('button', { name: 'Move' }).click();

  await expect.poll(async () => (await api.streams()).some((s) => s.title === 'Split-off topic')).toBe(true);
  const created = (await api.streams()).find((s) => s.title === 'Split-off topic');
  const moved = ((await api.get(`/api/streams/${created.id}/items`)).json as any[]).find((i) => i.source === 'slack');
  expect(moved.data.messages.map((m: any) => m.id)).toContain(first.id);
  expect(moved.title).toBe(slack.title);
  // the other messages stay where they were
  expect(((await slackOf())?.data.messages ?? []).length).toBe(slack.data.messages.length - 1);
  // the original stream no longer holds that message
  const left = ((await api.get(`/api/streams/${src.id}/items`)).json as any[]).filter((i) => i.source === 'slack').flatMap((i) => i.data.messages.map((m: any) => m.id));
  expect(left).not.toContain(first.id);
});
