import path from 'node:path';
import { test, expect, freshApp, api, demoDataDir, WEB } from './helpers';

freshApp();

test('Settings → Writing style: learn a guide from my sent messages, review it, save; drafts use it', async ({ page }) => {
  await page.goto(`${WEB}/settings?section=style`);
  await page.getByRole('button', { name: 'Learn from my sent messages' }).click();
  await expect(page.locator('.settings-body')).toContainText('Not enough of your own messages');

  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  const me = { name: 'Alex Rivera', email: 'alex.rivera@example.com' };
  for (let i = 0; i < 4; i++) {
    const msgs = [
      { id: `q${i}`, author: { name: 'Dana', email: 'dana@example.com' }, to: [me.email, 'lee@example.com'], text: 'Can you check?', at: new Date(Date.now() - 60_000).toISOString() },
      { id: `r${i}`, author: me, to: ['dana@example.com', 'lee@example.com'], text: 'Done.\nThanks,\nAlex', at: new Date().toISOString(), isFromPU: true },
    ];
    db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run(`style${i}`, null, 'gmail', 'email_thread', `ext-style${i}`, 'Thread', null, JSON.stringify({ messages: msgs }), new Date().toISOString());
  }
  db.close();

  await page.getByRole('button', { name: 'Learn from my sent messages' }).click();
  await expect(page.locator('.settings-body')).toContainText('Learned from 4 emails and 0 Slack messages');
  const guide = page.getByLabel('Writing style guide');
  await expect(guide).toHaveValue(/Short and direct[\s\S]*Copying people\n- You usually reply-all on group threads \(4 of 4\)/);
  await guide.press('End');
  await guide.pressSequentially('\n- Never use exclamation marks.');
  await page.locator('.settings-body').screenshot({ path: 'qa/results/writing-style.png' });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  const style = (await api.get('/api/settings')).json.style;
  expect(style.enabled).toBe(true);
  expect(style.guide).toContain('Never use exclamation marks.');
  // the model for it is listed with the others
  await page.goto(`${WEB}/settings?section=claude`);
  await expect(page.locator('.settings-body')).toContainText('Learning your writing style');
});
