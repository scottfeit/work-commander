import { test, expect, freshApp, api, stream, watchPage, WEB } from './helpers';

freshApp();

test.beforeAll(async () => {
  await api.waitPending(['ticket_create', 'email_reply']);
});

test('Settings round trip keeps the dashboard fully usable (regression: could not open work item)', async ({ page }) => {
  const problems = watchPage(page);
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  await expect(page.locator('.tabbar').getByRole('img', { name: 'Gmail' })).toBeVisible();

  await page.getByRole('button', { name: /settings/i }).first().click();
  await expect(page).toHaveURL(/\/settings/);
  for (const section of ['Primary user & org chart', 'Claude', 'Google Workspace', 'Slack', 'Atlassian', '1Password', 'Secrets', 'Status & audit']) {
    await page.getByRole('button', { name: section }).first().click();
  }
  await page.getByRole('button', { name: /dashboard/i }).first().click();
  await expect(page).not.toHaveURL(/settings/);

  // Re-select the stream (also a different one first, so the click is a real selection change)
  await page.getByRole('button', { name: /all open work/i }).click();
  await expect(page.locator('.top-pane')).toContainText(/open work streams/i);
  await stream(page, /contractor access/i).click();
  await expect(page.locator('.tabbar').getByRole('img', { name: 'Gmail' })).toBeVisible();
  await page.locator('.tabbar').getByRole('img', { name: 'Gmail' }).click();
  await expect(page.locator('.top-pane')).toContainText(/Priya Shah/);
  await expect(page.locator('.draft')).toHaveCount(2);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('deep links and browser history work', async ({ page }) => {
  await page.goto(WEB + '/settings');
  await expect(page.getByRole('button', { name: /dashboard/i }).first()).toBeVisible();
  await page.getByRole('button', { name: /dashboard/i }).first().click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/settings/);
  await page.goForward();
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.reload();
  await expect(page.locator('.sidebar')).toBeVisible();
});

test('unknown URLs do not leave a blank page', async ({ page }) => {
  await page.goto(WEB + '/definitely/not/a/page');
  await expect(page.locator('body')).not.toBeEmpty();
  await expect(page.locator('.sidebar, .error, h1, h2').first()).toBeVisible();
});

test('stream filter and new-stream creation', async ({ page }) => {
  await page.goto(WEB);
  await page.getByPlaceholder('Filter streams').fill('zzz-no-such-stream');
  await expect(page.locator('button.stream-open')).toHaveCount(0);
  await page.getByPlaceholder('Filter streams').fill('');
  await page.getByTitle('New work stream').click();
  await page.getByPlaceholder('Work stream title').fill('QA manual stream');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(stream(page, /QA manual stream/)).toBeVisible();
  await expect(page.locator('.chat')).toContainText(/QA manual stream/);
  // empty title is rejected rather than creating a blank stream
  const n = (await api.streams()).length;
  await page.getByTitle('New work stream').click();
  await page.getByPlaceholder('Work stream title').fill('   ');
  await page.getByRole('button', { name: 'Add' }).click();
  expect((await api.streams()).length).toBe(n);
});

test('chat: sending a message shows it and gets a reply, empty messages are blocked', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const send = page.locator('.composer button.btn');
  await expect(send).toBeDisabled();
  await page.locator('.composer textarea, .composer input').first().fill('hello from QA');
  await send.click();
  await expect(page.locator('.chat-scroll')).toContainText('hello from QA');
  await expect(page.locator('.bubble.assistant').last()).toBeVisible({ timeout: 15_000 });
});

test('page recovers itself when the server restarts (boot id changes)', async ({ page }) => {
  let connections = 0;
  await page.route('**/api/events', async (route) => {
    connections++;
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `event: boot\ndata: boot-${connections}\n\n` });
  });
  let loads = 0;
  page.on('load', () => loads++);
  await page.goto(WEB);
  await expect.poll(() => loads, { timeout: 15_000, message: 'page should reload itself after the server announces a new boot id' }).toBeGreaterThanOrEqual(2);
});
