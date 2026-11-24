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

test("a timer Claude thinks of itself is only suggested: Set timer starts it, No thanks doesn't", async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const send = async (text: string) => {
    await page.locator('.composer textarea').fill(text);
    await page.locator('.composer').getByRole('button', { name: 'Send' }).click();
  };
  await send('keep an eye on this please');
  const bubble = page.getByRole('group', { name: 'Suggested timed instruction' });
  await expect(bubble).toContainText('check for new replies on this thread');
  await expect(bubble).toContainText('Would run ');
  await expect(page.locator('.sidebar .stream.active .timer-chip')).toHaveCount(0); // nothing counting down
  await bubble.screenshot({ path: 'qa/results/timer-suggested.png' });
  await bubble.getByRole('button', { name: 'Set timer' }).click();
  await expect(page.locator('.sidebar .stream.active .timer-chip')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Timed instruction' }).last()).toContainText('Runs ');
  // a second suggestion, turned down
  await send('keep an eye on this please');
  const second = page.getByRole('group', { name: 'Suggested timed instruction' });
  await second.getByRole('button', { name: 'No thanks' }).click();
  await expect(page.getByText('Not set')).toBeVisible();
  const sid = (await api.streams()).find((s: any) => /contractor access/i.test(s.title)).id;
  expect((await api.get('/api/streams')).json.find((s: any) => s.id === sid).timers).toHaveLength(1);
});

test('a finished timer puts a green ⏱✓ chip on the tile (red if it failed) until the stream is opened', async ({ page }) => {
  const path = await import('node:path');
  const { demoDataDir } = await import('./helpers');
  const { default: SQLite } = await import('better-sqlite3');
  const a = (await api.post('/api/streams', { title: 'Timer done stream', summary: '' })).json;
  const b = (await api.post('/api/streams', { title: 'Timer failed stream', summary: '' })).json;
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  const done = (ok: boolean) => JSON.stringify({ instruction: 'check for tickets on this topic', at: new Date().toISOString(), ok });
  db.prepare('update streams set timer_done = ? where id = ?').run(done(true), a.id);
  db.prepare('update streams set timer_done = ? where id = ?').run(done(false), b.id);
  db.close();
  await page.goto(WEB);
  const tileA = page.locator('.sidebar .stream', { has: page.locator('button.stream-open', { hasText: a.title.slice(0, 20) }) }).first();
  const chip = tileA.locator('.timer-done-chip');
  await expect(chip).toHaveText(/done/);
  const [r, g] = (await chip.evaluate((e) => getComputedStyle(e).backgroundColor)).match(/\d+/g)!.map(Number);
  expect(g).toBeGreaterThan(r); // green
  await tileA.screenshot({ path: 'qa/results/timer-done-chip.png' });
  const tileB = page.locator('.sidebar .stream', { has: page.locator('button.stream-open', { hasText: b.title.slice(0, 20) }) }).first();
  await expect(tileB.locator('.timer-done-chip')).toHaveText(/failed/);
  await tileA.locator('button.stream-open').click();
  await expect(chip).toHaveCount(0);
  await expect(tileB.locator('.timer-done-chip')).toHaveCount(1); // only the opened one clears
});
