import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();

test.beforeAll(async () => {
  await api.waitPending(['ticket_create', 'email_reply']);
});

test('@-mention in an email draft: people from the conversation and the org chart; picking one inserts the name and adds them to Cc', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const draft = page.locator('.draft.kind-email_reply');
  const body = draft.getByLabel('Message');
  await body.click();
  await body.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await body.pressSequentially('\nLooping in @jor');
  const pop = page.getByRole('listbox', { name: 'Mention someone' });
  await expect(pop.getByRole('option').first()).toContainText('Jordan Lee');
  await page.screenshot({ path: 'qa/results/mention-pop.png' });
  await body.press('Enter');
  await expect(pop).toHaveCount(0);
  await expect(body).toHaveValue(/Looping in @Jordan Lee $/);
  await expect(draft.getByLabel('Cc')).toHaveValue(/jordan\.lee@example\.com/);
  // saved with the draft, who was mentioned
  await draft.getByRole('button', { name: 'Save edits' }).click();
  await expect.poll(async () => {
    const p = ((await api.get('/api/proposals?status=pending')).json as any[]).find((x) => x.kind === 'email_reply');
    return [p.payload.mentions?.map((m: any) => m.name), (Array.isArray(p.payload.cc) ? p.payload.cc : [p.payload.cc]).join(',')];
  }).toEqual([['Jordan Lee'], expect.stringContaining('jordan.lee@example.com')]);

  // people in the conversation come first; Esc closes the list
  await body.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await body.pressSequentially('@l');
  await expect(pop.getByRole('option').first()).toContainText('Lee Wong');
  await body.press('Escape');
  await expect(pop).toHaveCount(0);
});
