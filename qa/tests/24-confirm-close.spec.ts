import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();

const statusOf = async (id: string) => (await api.streams()).find((s) => s.id === id)?.status;
const setConfirm = async (confirmClose: boolean) => {
  const s = (await api.get('/api/settings')).json;
  await api.call('PUT', '/api/settings', { ...s, ui: { ...s.ui, confirmClose } });
};

test('Closing a work stream takes two clicks by default', async ({ page }) => {
  const id = (await api.post('/api/streams', { title: 'Close twice stream', summary: '' })).json.id;
  await page.goto(WEB);
  await stream(page, /close twice stream/i).click();
  const btn = page.locator('.item-head').getByRole('button', { name: 'Close stream' });
  await btn.click();
  await expect(page.locator('.item-head').getByRole('button', { name: 'Confirm close' })).toBeVisible();
  expect(await statusOf(id)).toBe('open');
  await page.locator('.item-head').getByRole('button', { name: 'Confirm close' }).click();
  await expect.poll(() => statusOf(id)).toBe('closed');
});

test('With the setting off, one click closes it (in the list and on the Overview)', async ({ page }) => {
  await setConfirm(false);
  const a = (await api.post('/api/streams', { title: 'Close once overview', summary: '' })).json.id;
  const b = (await api.post('/api/streams', { title: 'Close once tile', summary: '' })).json.id;
  await page.goto(WEB);
  await stream(page, /close once overview/i).click();
  await page.locator('.item-head').getByRole('button', { name: 'Close stream' }).click();
  await expect.poll(() => statusOf(a)).toBe('closed');
  await stream(page, /close once tile/i).click();
  await page.locator('.stream-actions').getByRole('button', { name: 'Close stream' }).click();
  await expect.poll(() => statusOf(b)).toBe('closed');
  await setConfirm(true);
});

test("With the setting off, Claude's close suggestion in the drafts pane closes in one click too", async ({ page }) => {
  await setConfirm(false);
  const id = (await api.post('/api/streams', { title: 'Close once suggestion', summary: '' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const path = await import('node:path');
  const { demoDataDir } = await import('./helpers');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  const now = new Date().toISOString();
  const payload = JSON.stringify({ reason: 'All done.' });
  db.prepare("insert into proposals (id, stream_id, run_id, kind, system, title, rationale, payload, original_payload, editable, depends_on, status, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    'closeOnce', id, 'run-closeOnce', 'stream_close', 'internal', 'Close this work stream', 'All done.', payload, payload, JSON.stringify([{ key: 'reason', label: 'Reason', type: 'readonly' }]), '[]', 'pending', now,
  );
  db.close();
  await page.goto(WEB);
  await stream(page, /close once suggestion/i).click();
  await page.locator('.draft.kind-stream_close').getByRole('button', { name: 'Close stream' }).click();
  await expect.poll(() => statusOf(id), { timeout: 15_000 }).toBe('closed');
  await setConfirm(true);
});

test('the Drafts pane collapses to a thin bar and back; your choice holds across streams and reloads; a new draft opens it', async ({ page }) => {
  await api.post('/api/streams', { title: 'No drafts stream', summary: '' });
  await page.goto(WEB);
  await page.evaluate(() => localStorage.removeItem('wc.draftsHidden'));
  await page.reload();
  await stream(page, /no drafts stream/i).click();
  await expect(page.locator('.drafts')).toContainText('No drafts waiting'); // open by default, even with none
  await page.getByRole('button', { name: 'Hide the Drafts pane' }).click();
  const bar = page.getByRole('button', { name: /^Show the Drafts pane/ });
  await expect(bar).toBeVisible();
  await expect(page.locator('.drafts')).toHaveCount(0);
  const [b, bottom] = await Promise.all([bar.boundingBox(), page.locator('.bottom').boundingBox()]);
  expect(b!.width).toBeLessThan(40);
  expect(Math.abs(b!.x + b!.width - (bottom!.x + bottom!.width))).toBeLessThan(2); // at the right edge

  // other streams (even with drafts already waiting) stay collapsed; the bar shows the count
  await stream(page, /contractor access/i).click();
  await expect(bar).toHaveAttribute('aria-label', 'Show the Drafts pane (2 waiting)');
  await page.locator('.bottom').screenshot({ path: 'qa/results/drafts-bar.png' });
  await page.reload();
  await stream(page, /contractor access/i).click();
  await expect(bar).toBeVisible();

  // a draft arriving while you look opens it; once you switch streams, your choice applies again
  await page.locator('.top-pane .item-head').getByRole('button', { name: 'Quick reply' }).click();
  await expect(page.locator('.drafts')).toBeVisible();
  await stream(page, /no drafts stream/i).click();
  await expect(bar).toBeVisible();
  // ...and it stays open until that stream has no drafts left
  await stream(page, /contractor access/i).click();
  await expect(bar).toBeVisible();

  // the bar opens it again, for good
  await bar.click();
  await expect(page.locator('.drafts')).toBeVisible();
  await page.reload();
  await stream(page, /no drafts stream/i).click();
  await expect(page.locator('.drafts')).toContainText('No drafts waiting');
  // the old "keep open" setting is gone
  await page.goto(`${WEB}/settings?section=display`);
  await expect(page.getByText('Keep the Drafts pane open')).toHaveCount(0);
});
