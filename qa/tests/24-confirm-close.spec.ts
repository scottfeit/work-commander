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
  await expect(page.locator('.item-head').getByRole('button', { name: 'Click again to close' })).toBeVisible();
  expect(await statusOf(id)).toBe('open');
  await page.locator('.item-head').getByRole('button', { name: 'Click again to close' }).click();
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
