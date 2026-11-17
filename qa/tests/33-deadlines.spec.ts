import path from 'node:path';
import { test, expect, freshApp, api, stream, demoDataDir, WEB } from './helpers';

freshApp();

test('due dates: chip on the tile (overdue first in Open), a due line with its quote in the Overview, Change and Clear; "they\'ll deliver" in the Pending ▾ menu', async ({ page }) => {
  const late = (await api.post('/api/streams', { title: 'Late report stream', summary: '' })).json.id;
  const later = (await api.post('/api/streams', { title: 'Later report stream', summary: '' })).json.id;
  // the late one has the oldest activity, but being overdue puts it first
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  const day = 86_400_000;
  db.prepare('update streams set last_activity_at = ?, deadlines = ? where id = ?').run(new Date(Date.now() - 5 * day).toISOString(), JSON.stringify({ due: { at: new Date(Date.now() - 2 * day).toISOString(), allDay: true, quote: 'need the report by Friday', who: 'Dana', source: 'gmail', by: 'triage' } }), late);
  db.prepare('update streams set deadlines = ? where id = ?').run(JSON.stringify({ due: { at: new Date(Date.now() + 10 * day).toISOString(), allDay: true, by: 'triage' }, promised: { at: new Date(Date.now() + 3 * day).toISOString(), allDay: true, quote: "I'll get you the data by Thursday", who: 'Lee Wong', by: 'triage' } }), later);
  db.close();

  await page.goto(WEB);
  const firstOpen = page.locator('.sidebar .stream:not(.general)').first();
  await expect(firstOpen).toContainText('Late report stream');
  await expect(firstOpen.locator('.due-chip')).toHaveText('overdue 2d');
  await expect(firstOpen.locator('.due-chip')).toHaveClass(/overdue/);
  await expect(page.locator('.sidebar .stream', { hasText: 'Later report stream' }).locator('.due-chip')).toHaveText(/^due /);

  await stream(page, /late report stream/i).click();
  const ov = page.locator('.overview-pane');
  await expect(ov.locator('.due-line').first()).toContainText('Due');
  await expect(ov.locator('.due-quote')).toContainText('"need the report by Friday" — Dana, email');
  await page.locator('.app').screenshot({ path: 'qa/results/deadlines.png' });

  // Change: pick a date; it's yours now
  await ov.locator('.due-line').getByRole('button', { name: 'Change' }).click();
  const target = new Date(Date.now() + 4 * day);
  const ymd = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
  await ov.getByLabel('Due date', { exact: true }).fill(ymd);
  await ov.getByRole('button', { name: 'Set', exact: true }).click();
  await expect.poll(async () => (await api.streams()).find((s) => s.id === late)?.due?.by).toBe('you');
  await expect(page.locator('.sidebar .stream', { hasText: 'Late report stream' }).locator('.due-chip')).not.toHaveClass(/overdue/);
  // Clear
  await ov.getByRole('button', { name: 'Clear the due date' }).click();
  await expect.poll(async () => (await api.streams()).find((s) => s.id === late)?.due ?? null).toBeNull();
  await expect(page.locator('.sidebar .stream', { hasText: 'Late report stream' }).locator('.due-chip')).toHaveCount(0);

  // they'll deliver: shown in the Overview, and offered as a snooze
  await stream(page, /later report stream/i).click();
  await expect(ov).toContainText("They'll deliver");
  await page.locator('.sidebar .stream.active').getByRole('button', { name: 'Snooze until…' }).click();
  const menu = page.getByRole('menu', { name: 'Snooze until' });
  const opt = menu.getByRole('menuitem', { name: /Until they deliver/ });
  await expect(opt).toContainText('(Lee)');
  await page.screenshot({ path: 'qa/results/deadlines-snooze.png' });
  await opt.click();
  await expect.poll(async () => (await api.streams()).find((s) => s.id === later)?.snoozeUntil?.slice(0, 13)).toBe(new Date(Date.now() + 3 * day).toISOString().slice(0, 13));
});
