import { test, expect, freshApp, api, stream, watchPage, WEB } from './helpers';

/**
 * The headline scenario from the product brief, driven through the real UI:
 * email asks a question -> ticket + reply drafts -> PU edits/approves -> Claude offers to work on it ->
 * Slack question -> teammate replies -> 1Password access -> ticket comment + transition + email -> stream closes.
 */
freshApp();
test.describe.configure({ mode: 'serial' });

const kind = (page: import('@playwright/test').Page, k: string) => page.locator(`.draft.kind-${k}`);

test('dashboard layout has every pane from the brief', async ({ page }) => {
  await page.goto(WEB);
  await expect(page.locator('.sidebar')).toBeVisible(); // left: work streams
  await expect(page.locator('.tabbar')).toBeVisible(); // top: tab bar
  await expect(page.locator('.top-pane')).toBeVisible(); // top: stream info
  await expect(page.locator('.chat')).toBeVisible(); // bottom-left: Claude chat
  await expect(page.getByText('Open ·')).toBeVisible();
  await expect(page.getByRole('button', { name: /settings/i }).first()).toBeVisible();
});

test('incoming email becomes an AI-labelled work stream; the newsletter does not', async ({ page }) => {
  await page.goto(WEB);
  await expect(stream(page, /contractor access/i)).toBeVisible({ timeout: 30_000 });
  const titles = await page.locator('button.stream .stream-title').allInnerTexts();
  expect(titles.join('|')).not.toMatch(/SaaS|newsletter|10 tools/i);
  // AI-generated label chips on the stream row
  await expect(stream(page, /contractor access/i).locator('.chip').first()).toBeVisible();
});

test('opening the stream shows email tab and two linked drafts', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  await expect(page.locator('.tabbar')).toContainText('Overview');
  await expect(page.locator('.tabbar').getByRole('img', { name: 'Gmail' })).toBeVisible();
  await api.waitPending(['ticket_create', 'email_reply']);
  await expect(kind(page, 'ticket_create')).toBeVisible();
  await expect(kind(page, 'email_reply')).toBeVisible();
  await expect(kind(page, 'email_reply')).toContainText(/Runs after/i);
  // The ticket must be assigned to the PU with the original asker as requester.
  const [ticket] = await api.waitPending(['ticket_create']);
  expect(ticket.payload.requester_email).toBe('priya.shah@example.com');
});

test('PU can edit the email draft (adding a recipient) and approve ticket then email', async ({ page }) => {
  const problems = watchPage(page);
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const email = kind(page, 'email_reply');
  await expect(email).toBeVisible();

  // Edit the body, and add a second recipient by typing (comma-separated list field).
  const body = email.getByLabel('Message');
  await body.fill((await body.inputValue()) + '\n\nQA-EDIT-MARKER');
  const to = email.getByLabel(/^To/);
  await to.fill('lee.wong@example.com, qa.extra@example.com'); // typing behaviour itself is covered in 06-ui-quality

  await kind(page, 'ticket_create').getByRole('button', { name: /approve/i }).click();
  await expect(kind(page, 'ticket_create')).toHaveCount(0);
  await email.getByRole('button', { name: /approve/i }).click();
  await expect(email).toHaveCount(0);

  // The sent thread must contain the edit, the new recipient and a *resolved* ticket reference.
  const [ticket, mail] = (await api.proposals()).filter((p) => ['ticket_create', 'email_reply'].includes(p.kind));
  await api.waitStatus(ticket.id, 'executed');
  const sent = await api.waitStatus(mail.id, 'executed');
  expect(JSON.stringify(sent.payload)).toContain('QA-EDIT-MARKER');
  expect(JSON.stringify(sent.payload)).toContain('qa.extra@example.com');
  expect(JSON.stringify(sent.payload)).not.toContain('{{');
  expect(problems, problems.join('\n')).toEqual([]);
});

test('Claude asks whether to work on the ticket; answering produces a Slack draft', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  await expect(page.locator('.bubble.question')).toContainText(/work on it/i, { timeout: 20_000 });
  await page.getByRole('button', { name: 'Yes, work on it' }).click();
  const slack = kind(page, 'slack_post');
  await expect(slack).toBeVisible({ timeout: 20_000 });
  // Editable before sending
  const text = slack.getByLabel(/message|text/i).first();
  await text.fill((await text.inputValue()) + ' (QA edit)');
  await slack.getByRole('button', { name: /approve/i }).click();
  await expect(slack).toHaveCount(0);
});

test("teammate's Slack reply arrives and Claude requests 1Password access", async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  await expect(page.locator('.tabbar')).toContainText(/Slack|DM with/i, { timeout: 30_000 });
  const cred = kind(page, 'credential_request');
  await expect(cred).toBeVisible({ timeout: 30_000 });
  await expect(cred).toContainText(/Acme Admin Console/i);
  await cred.getByRole('button', { name: /grant access/i }).click();
  await expect(cred).toHaveCount(0);
});

test('final drafts (ticket comment, transition, email) are approved with Approve all', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  await api.waitPending(['ticket_comment', 'ticket_transition', 'email_reply'], 40_000);
  await expect(page.locator('.draft')).toHaveCount(3);
  await page.getByRole('button', { name: /approve all/i }).click();
  await expect(page.locator('.draft.kind-ticket_comment')).toHaveCount(0, { timeout: 20_000 });
  // The draft pane clears as soon as items are approved; execution follows (in dependency order), so wait for it.
  await expect
    .poll(async () => (await api.proposals()).filter((p) => ['ticket_comment', 'ticket_transition', 'email_reply'].includes(p.kind)).map((p) => p.status), { timeout: 20_000 })
    .toEqual(['executed', 'executed', 'executed', 'executed']);
});

test('Claude proposes closing the stream; approving hides it until "closed" is shown', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const close = kind(page, 'stream_close');
  await expect(close).toBeVisible({ timeout: 30_000 });
  // Closing a work stream takes two clicks: the first arms the button, the second does it.
  await close.getByRole('button', { name: /close stream/i }).click();
  await expect(close.getByRole('button', { name: /click again/i })).toBeVisible();
  await close.getByRole('button', { name: /click again/i }).click();
  await expect(stream(page, /contractor access/i)).toHaveCount(0, { timeout: 15_000 });
  // Closed streams are hidden by default but reachable.
  await page.getByText(/show closed|closed/i).first().click();
  await expect(stream(page, /contractor access/i)).toBeVisible();
});

test('the whole flow completed without a single failed action', async () => {
  expect(await api.auditFailures()).toEqual([]);
  const p = await api.proposals();
  expect(p.filter((x) => x.status === 'failed' || x.status === 'pending')).toEqual([]);
});
