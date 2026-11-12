import path from 'node:path';
import { test, expect, freshApp, api, stream, demoDataDir, WEB } from './helpers';

freshApp();

const LONG = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of a long email body.`).join('\n');
const BODY = [
  'Check the audit log [https://example.atlassian.net/plugins/servlet/ac/x/cb-config?',
  'project.key=IT&project.id=10000#/rule/01a05941/audit-log] for details.',
  'See https://example.com/docs/page.html. Also (https://example.org/a).',
  'Slack style <https://example.net/browse/IT-1|IT-1 ticket> end.',
  'Not a link: javascript:alert(1) and example.com',
  LONG,
].join('\n');

test.beforeAll(async () => {
  const id = (await api.post('/api/streams', { title: 'Item view test', summary: '' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run(
    'ivt1',
    id,
    'gmail',
    'email_thread',
    'ivt-ext',
    'Automation flow failed',
    null,
    JSON.stringify({ messages: [{ id: 'm1', author: { name: 'Atlassian', email: 'noreply@x.com' }, to: ['me@x.com'], text: BODY, at: '2026-10-01T00:00:00.000Z' }] }),
    '2026-10-01T00:00:00.000Z',
  );
  db.close();
});

test('links in a message are clickable and open in a new tab', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /item view test/i).click();
  await page.locator('.tabbar [role=tab]', { hasText: 'Automation' }).click();
  const links = page.locator('.item-view .body a');
  const hrefs = await links.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href')));
  expect(hrefs).toEqual([
    'https://example.atlassian.net/plugins/servlet/ac/x/cb-config?project.key=IT&project.id=10000#/rule/01a05941/audit-log', // wrapped URL rejoined
    'https://example.com/docs/page.html', // trailing full stop is not part of it
    'https://example.org/a', // nor the closing bracket
    'https://example.net/browse/IT-1',
  ]);
  for (const a of await links.all()) {
    await expect(a).toHaveAttribute('target', '_blank');
    await expect(a).toHaveAttribute('rel', /noopener/);
  }
  await expect(links.nth(3)).toHaveText('IT-1 ticket');
  await expect(page.locator('.item-view .body')).toContainText('javascript:alert(1)'); // shown as text, not linked
});

test('the tab bar does not scroll vertically', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /item view test/i).click();
  const m = await page.locator('.tabbar').evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, oy: getComputedStyle(el).overflowY }));
  expect(m.sh).toBeLessThanOrEqual(m.ch);
  expect(m.oy).toBe('hidden');
});

test('the work item header stays put while the content scrolls', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /item view test/i).click();
  await page.locator('.tabbar [role=tab]', { hasText: 'Automation' }).click();
  const head = page.locator('.item-view .item-head');
  const top = (await head.boundingBox())!.y;
  await page.locator('.top-pane').evaluate((el) => el.scrollTo(0, 600));
  await expect.poll(async () => page.locator('.top-pane').evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
  expect(Math.abs((await head.boundingBox())!.y - top)).toBeLessThan(2);
  await expect(head.getByRole('button', { name: 'Quick reply' })).toBeInViewport();
  await expect(head.getByRole('button', { name: 'Not relevant' })).toBeInViewport();
});

test('the close icon left of Overview closes the stream only on the second click', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /item view test/i).click();
  const icon = page.getByRole('button', { name: 'Close work stream' });
  const overview = page.locator('.tabbar [role=tab]', { hasText: 'Overview' });
  expect((await icon.boundingBox())!.x).toBeLessThan((await overview.boundingBox())!.x);

  await icon.click(); // arms
  await expect(icon).toContainText('Close?');
  await page.waitForTimeout(300);
  expect((await api.get('/api/streams')).json.some((s: any) => /item view test/i.test(s.title))).toBe(true); // still open
  await icon.click(); // confirms
  await expect.poll(async () => (await api.get('/api/streams')).json.some((s: any) => /item view test/i.test(s.title))).toBe(false);
});

test('the Overview "Close stream" button also needs two clicks', async ({ page }) => {
  const id = (await api.post('/api/streams', { title: 'Overview close test', summary: '' })).json.id;
  await page.goto(WEB);
  await stream(page, /overview close test/i).click();
  await page.locator('.tabbar [role=tab]', { hasText: 'Overview' }).click();
  const btn = page.locator('.item-view.overview').getByRole('button', { name: /close stream/i });
  await btn.click();
  await expect(page.locator('.item-view.overview').getByRole('button', { name: /click again/i })).toBeVisible();
  expect((await api.get(`/api/streams`)).json.find((s: any) => s.id === id).status).toBe('open');
  await page.locator('.item-view.overview').getByRole('button', { name: /click again/i }).click();
  await expect.poll(async () => (await api.get(`/api/streams?includeClosed=1`)).json.find((s: any) => s.id === id).status).toBe('closed');
});
