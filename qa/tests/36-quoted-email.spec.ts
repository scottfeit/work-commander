import path from 'node:path';
import { test, expect, freshApp, api, stream, demoDataDir, WEB } from './helpers';

freshApp();

test('an email\'s earlier quoted part ("On … wrote:" and below) is folded behind a triangle, in the text and the Original view', async ({ page }) => {
  const sid = (await api.post('/api/streams', { title: 'IRS audit stream', summary: '' })).json.id;
  const text = 'Hi Chris,\n\nAttached are the 2026 reports.\n\nThanks,\nScott\n\nOn Wed, Nov 11, 2026, at 1:22 AM, Scott Feit wrote:\n> Need help with IRS audit\n> HIDDEN-EARLIER-TEXT';
  const html = '<div>Hi Chris,<br><br>Attached are the 2026 reports.<br>Thanks,<br>Scott</div><div class="gmail_quote"><div class="gmail_attr">On Wed, Nov 11, 2026, at 1:22 AM, Scott Feit wrote:</div><blockquote>Need help with IRS audit<br>HIDDEN-EARLIER-HTML</blockquote></div>';
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run('irs1', sid, 'gmail', 'email_thread', 'irs-ext', 'Need help with IRS audit', null, JSON.stringify({ messages: [{ id: 'q1', author: { name: 'Scott Feit', email: 'scott@example.com' }, to: ['chris@example.com'], text, at: new Date().toISOString() }] }), new Date().toISOString());
  db.prepare('insert into message_html (item_id, message_id, html) values (?,?,?)').run('irs1', 'q1', html);
  db.close();

  await page.goto(WEB);
  await stream(page, /irs audit stream/i).click();
  const msg = page.locator('.top-pane .msg').first();
  await expect(msg).toContainText('Attached are the 2026 reports.');
  await expect(msg).not.toContainText('On Wed, Nov 11, 2026, at 1:22 AM');
  await expect(msg).not.toContainText('HIDDEN-EARLIER-TEXT');
  const toggle = msg.getByRole('button', { name: /Earlier messages/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.locator('.top-pane').screenshot({ path: 'qa/results/quoted-folded.png' });
  await toggle.click();
  await expect(msg).toContainText('On Wed, Nov 11, 2026, at 1:22 AM, Scott Feit wrote:');
  await expect(msg).toContainText('HIDDEN-EARLIER-TEXT');

  // the Original (HTML) view folds it too
  await msg.getByRole('button', { name: 'Original' }).click();
  const frame = page.frameLocator('.top-pane .msg iframe').first();
  await expect(frame.locator('body')).toContainText('Attached are the 2026 reports.');
  await expect(frame.locator('details.wc-quoted')).not.toHaveAttribute('open', '');
  await expect(frame.getByText('HIDDEN-EARLIER-HTML')).toBeHidden();
  const h0 = (await page.locator('.top-pane .msg iframe').boundingBox())!.height;
  await frame.locator('details.wc-quoted > summary').click();
  await expect(frame.getByText('HIDDEN-EARLIER-HTML')).toBeVisible();
  await expect.poll(async () => (await page.locator('.top-pane .msg iframe').boundingBox())!.height).toBeGreaterThan(h0); // the frame grows to fit
});
