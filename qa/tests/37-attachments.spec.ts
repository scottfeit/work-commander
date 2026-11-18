import path from 'node:path';
import { test, expect, freshApp, api, stream, demoDataDir, WEB } from './helpers';

freshApp();

test('attachments show in the work item: images inline, other files as chips that download', async ({ page }) => {
  const sid = (await api.post('/api/streams', { title: 'Attachments stream', summary: '' })).json.id;
  const msg = {
    id: 'am1',
    author: { name: 'Chris Bednar', email: 'chris@example.com' },
    text: 'Reports attached.',
    at: new Date().toISOString(),
    attachments: [
      { id: '1', name: '2026 financials.pdf', mimeType: 'application/pdf', size: 52_000, ref: 'ATT-PDF' },
      { id: '2', name: 'chart.png', mimeType: 'image/png', size: 120, ref: 'ATT-PNG' },
      { id: '3', name: 'logo.svg', mimeType: 'image/svg+xml', size: 300, ref: 'ATT-SVG' },
    ],
  };
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run('att1', sid, 'gmail', 'email_thread', 'att-ext', 'IRS reports', null, JSON.stringify({ messages: [msg] }), new Date().toISOString());
  db.close();

  await page.goto(WEB);
  await stream(page, /attachments stream/i).click();
  const att = page.locator('.top-pane .msg .attachments');
  const img = att.locator('img[alt="chart.png"]');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0); // the bytes came through
  // the PDF and the SVG are download chips (SVG never inline)
  await expect(att.locator('.att-file')).toHaveText([/2026 financials\.pdf\s*51 KB/, /logo\.svg/]);
  await page.locator('.top-pane').screenshot({ path: 'qa/results/attachments.png' });

  const [dl] = await Promise.all([page.waitForEvent('download'), att.locator('.att-file', { hasText: 'financials' }).click()]);
  expect(dl.suggestedFilename()).toBe('2026 financials.pdf');
  // served as a download, locked down
  const r = await page.request.get(`${WEB}/api/items/att1/attachments/3?inline=1`);
  expect(r.headers()['content-type']).toBe('application/octet-stream');
  expect(r.headers()['content-disposition']).toMatch(/^attachment;/);
  expect(r.headers()['x-content-type-options']).toBe('nosniff');
  expect((await page.request.get(`${WEB}/api/items/att1/attachments/nope`)).status()).toBe(404);
});
