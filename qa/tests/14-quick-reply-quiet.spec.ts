import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();

test.beforeAll(async () => {
  await api.waitPending(['ticket_create', 'email_reply']);
});

test('closing a Quick Reply does not wake Claude', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const s = (await api.get('/api/streams')).json.find((x: any) => /contractor access/i.test(x.title));
  await page.locator('.tabbar').getByRole('img', { name: 'Gmail' }).click();
  await page.getByRole('button', { name: 'Quick reply' }).click();
  const quick = page.locator('.draft', { hasText: /Quick reply/ });
  await expect(quick).toBeVisible();

  const chat = async () => (await api.get(`/api/streams/${s.id}/chat`)).json as { role: string; content: string }[];
  const before = (await chat()).length;
  await quick.getByRole('button', { name: /^reject$/i }).click(); // opens the reason box
  await quick.getByRole('button', { name: /^reject$/i }).click(); // closes the draft
  await expect(quick).toHaveCount(0);
  await page.waitForTimeout(3500); // the demo agent answers within about a second if it were woken
  const after = await chat();
  expect(after.length).toBe(before);
  expect(after.some((m) => /rejected|left those undone|what should change/i.test(m.content) && m.role === 'assistant')).toBe(false);
});
