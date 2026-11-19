import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();

const setAfterClose = async (afterClose: string) => {
  const s = (await api.get('/api/settings')).json;
  await api.call('PUT', '/api/settings', { ...s, ui: { ...s.ui, afterClose } });
};
const active = (page: import('@playwright/test').Page) => page.locator('.sidebar .stream.active .stream-title');

test('closing the stream you are on: open the next one (default), keep showing it, or go to All open work', async ({ page }) => {
  const a = (await api.post('/api/streams', { title: 'Close order A', summary: '' })).json.id;
  await new Promise((r) => setTimeout(r, 20));
  const b = (await api.post('/api/streams', { title: 'Close order B', summary: '' })).json.id;
  await new Promise((r) => setTimeout(r, 20));
  await api.post('/api/streams', { title: 'Close order C', summary: '' });
  expect((await api.get('/api/settings')).json.ui.afterClose).toBe('next');

  // default: the next one down the Open list opens (C, B, A from the top: closing B opens A)
  await page.goto(WEB);
  await stream(page, /close order b/i).click();
  await page.locator('.sidebar .stream.active').getByRole('button', { name: 'Close stream' }).click();
  await page.locator('.sidebar .stream.active').getByRole('button', { name: 'Confirm close' }).click();
  await expect(active(page)).toHaveText('Close order A');
  await api.call('PATCH', `/api/streams/${b}`, { status: 'open' });

  // All open work
  await setAfterClose('all');
  // the page reads Settings twice on load; the second read is the one with the display options
  const settingsRead = () => {
    let n = 0;
    return page.waitForResponse((r) => r.url().endsWith('/api/settings') && r.request().method() === 'GET' && ++n === 2);
  };
  let read = settingsRead();
  await page.reload();
  await read;
  await stream(page, /close order a/i).click();
  await api.call('PATCH', `/api/streams/${a}`, { status: 'closed' }); // as approving Claude's "close it" would
  await expect(page.locator('.sidebar .stream.general')).toHaveClass(/active/);
  await api.call('PATCH', `/api/streams/${a}`, { status: 'open' });

  // keep showing it (even with Show closed off)
  await setAfterClose('stay');
  read = settingsRead();
  await page.reload();
  await read;
  await stream(page, /close order a/i).click();
  await api.call('PATCH', `/api/streams/${a}`, { status: 'closed' });
  await expect(active(page)).toHaveText('Close order A');
  await expect(page.locator('.sidebar .stream.active').getByRole('button', { name: 'Reopen stream' })).toBeVisible();

  await page.goto(`${WEB}/settings?section=display`);
  await expect(page.getByText('When I close a work stream')).toBeVisible();
  await setAfterClose('next');
});
