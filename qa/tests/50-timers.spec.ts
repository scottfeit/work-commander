import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();

test('a timed instruction: set by telling Claude, shown in the chat and on the card, and cancellable from the chat', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  await page.locator('.composer textarea').fill('in 30 minutes, check for tickets on this topic');
  await page.locator('.composer').getByRole('button', { name: 'Send' }).click();
  const bubble = page.getByRole('group', { name: 'Timed instruction' });
  await expect(bubble).toContainText('check for tickets on this topic');
  await expect(bubble).toContainText('Runs ');
  const chip = page.locator('.sidebar .stream.active .timer-chip');
  await expect(chip).toBeVisible();
  await page.locator('.chat').screenshot({ path: 'qa/results/timer-chat.png' });
  await page.locator('.sidebar .stream.active').screenshot({ path: 'qa/results/timer-card.png' });
  await bubble.getByRole('button', { name: 'Cancel' }).click();
  await expect(bubble).toContainText('Cancelled');
  await expect(chip).toHaveCount(0);
  const sid = (await api.streams()).find((s: any) => /contractor access/i.test(s.title)).id;
  expect((await api.get(`/api/streams`)).json.find((s: any) => s.id === sid).timers).toEqual([]);
});
