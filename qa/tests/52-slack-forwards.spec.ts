import path from 'node:path';
import { test, expect, freshApp, api, demoDataDir, stream, WEB } from './helpers';

freshApp();

test('a forwarded Slack message shows inside the message that forwarded it, as Slack shows it', async ({ page }) => {
  const sid = (await api.post('/api/streams', { title: 'Forward stream', summary: '' })).json.id;
  const t = (m: number) => new Date(Date.now() - (60 - m) * 60_000).toISOString();
  const msgs = [
    {
      id: '200.000001',
      author: { name: 'Lee Wong' },
      text: 'Can you check this one?',
      at: t(1),
      forwarded: [{ author: 'Sam Ortiz', channel: '#ops-alerts', at: t(0), text: 'Disk usage on db-2 is at 95%', url: 'https://acme.slack.com/archives/C1/p1', attachments: [{ id: 'F1', name: 'disk.log', mimeType: 'text/plain', ref: 'x' }] }],
    },
  ];
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run('fwd1', sid, 'slack', 'slack_thread', 'D0FWD:dm', 'Forward DM', null, JSON.stringify({ messages: msgs, slack: { channel: 'D0FWD', threadTs: '200.000001' } }), t(1));
  db.close();
  await page.goto(WEB);
  await stream(page, /Forward stream/).click();
  await page.getByText('Forward DM', { exact: true }).first().click();
  const msg = page.locator('article.msg', { hasText: 'Can you check this one?' });
  const fwd = msg.getByRole('blockquote');
  await expect(fwd).toHaveAccessibleName('Forwarded message from Sam Ortiz');
  await expect(fwd).toContainText('Disk usage on db-2 is at 95%');
  await expect(fwd).toContainText('Posted in #ops-alerts');
  await expect(fwd.getByRole('link', { name: 'View message' })).toHaveAttribute('href', 'https://acme.slack.com/archives/C1/p1');
  await expect(fwd).toContainText('disk.log');
  // it sits below the forwarder's own words
  expect((await fwd.boundingBox())!.y).toBeGreaterThan((await msg.getByText('Can you check this one?').boundingBox())!.y);
  await msg.screenshot({ path: 'qa/results/slack-forward.png' });
});
