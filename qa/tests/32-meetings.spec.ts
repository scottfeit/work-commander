import path from 'node:path';
import { test, expect, freshApp, api, stream, demoDataDir, WEB } from './helpers';

freshApp();

test('a linked meeting shows as a tab with its time and attendees; Settings → Meetings has the brief and follow-up options', async ({ page }) => {
  const id = (await api.post('/api/streams', { title: 'Meeting stream', summary: 'About the budget' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  const start = new Date(Date.now() + 3600_000);
  const meeting = { start: start.toISOString(), end: new Date(start.getTime() + 1800_000).toISOString(), attendees: ['alex.rivera@example.com', 'dana@example.com'] };
  db.prepare('insert into items (id, stream_id, source, kind, external_id, title, url, data, updated_at) values (?,?,?,?,?,?,?,?,?)').run('mtg1', id, 'calendar', 'event', 'ev-1', 'Budget sync', 'https://calendar.google.com/event?eid=1', JSON.stringify({ meeting }), new Date().toISOString());
  db.close();

  await page.goto(WEB);
  await stream(page, /meeting stream/i).click();
  await page.locator('.tabbar').getByRole('tab', { name: /Budget sync/ }).click();
  const view = page.locator('.top-pane .meeting');
  await expect(view).toContainText('Upcoming');
  await expect(view).toContainText('dana@example.com');
  await page.locator('.top-pane').screenshot({ path: 'qa/results/meeting-tab.png' });

  await page.goto(`${WEB}/settings?section=meetings`);
  await expect(page.getByLabel('Brief minutes before')).toHaveValue('30');
  await page.getByLabel('Brief minutes before').fill('15');
  await page.locator('.settings-body select').selectOption('draft');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(async () => (await api.get('/api/settings')).json.meetings).toEqual({ enabled: true, briefMinutes: 15, followUp: 'draft' });
});
