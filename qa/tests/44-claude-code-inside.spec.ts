import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();
// Run here writes BRIEF.md into the QA hand-off folder: clear it afterwards, as the other hand-off tests do
test.afterAll(() => fs.rmSync(path.join(os.homedir(), '.wc-qa-handoffs'), { recursive: true, force: true }));

const setCc = async (enabled: boolean) => {
  const s = (await api.get('/api/settings')).json;
  await api.call('PUT', '/api/settings', { ...s, claudeCode: { ...s.claudeCode, enabled, allowedDomains: ['github.com'] } });
};

test('off by default: no Run here, and its actions are refused', async ({ page }) => {
  expect((await api.get('/api/settings')).json.claudeCode.enabled).toBe(false);
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  await page.locator('.overview-pane').getByRole('button', { name: 'Hand off to Claude Code' }).click();
  await expect(page.locator('.overview-pane').getByRole('button', { name: 'Run here' })).toHaveCount(0);
  await expect(page.locator('.overview-pane').getByRole('button', { name: 'Hand off', exact: true })).toBeVisible(); // Terminal hand-off as before
  const sid = (await api.streams()).find((s) => /contractor access/i.test(s.title))!.id;
  expect((await api.get(`/api/streams/${sid}/claude-code`)).json).toMatchObject({ enabled: false, unavailable: expect.stringMatching(/off/) });
});

test('Run here: works in the chat, asks before a command, reports back; actions need WC\'s own page and its token', async ({ page }) => {
  await setCc(true);
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const sid = (await api.streams()).find((s) => /contractor access/i.test(s.title))!.id;

  // refused without the page's Origin and token, even from this machine
  expect((await api.post(`/api/streams/${sid}/claude-code/stop`, {})).status).toBe(403);
  const noToken = await page.evaluate(async (id) => (await fetch(`/api/streams/${id}/claude-code/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WC-Action': 'claude-code' }, body: '{}' })).status, sid);
  expect(noToken).toBe(403);

  const ov = page.locator('.overview-pane');
  await ov.getByRole('button', { name: 'Hand off to Claude Code' }).click();
  await expect(ov.getByRole('button', { name: 'Open in Terminal' })).toBeVisible();
  await ov.getByLabel('What should Claude Code do?').fill('List the folder');
  await ov.getByRole('button', { name: 'Run here' }).click();

  const chatPane = page.locator('.chat');
  await expect(chatPane).toContainText('Claude Code started in');
  const ask = chatPane.getByRole('group', { name: /Claude Code asks: Run a command/ });
  await expect(ask).toContainText('ls -la');
  await expect(chatPane.locator('.cc-state')).toContainText('waiting for you');
  await page.locator('.bottom').screenshot({ path: 'qa/results/claude-code-ask.png' });
  await ask.getByRole('button', { name: 'Allow' }).click();
  await expect(ask).toContainText('Allowed');
  await expect(chatPane).toContainText('Listed the folder (sandboxed: writes only here). Read BRIEF.md: allow. Done.');
  await expect(chatPane.locator('.cc-state')).toHaveCount(0);
  await expect.poll(async () => (await api.get(`/api/streams/${sid}/claude-code`)).json.session.state).toBe('done');

  // carry on in the same session from the chat
  const to = page.getByRole('radiogroup', { name: 'Send to' });
  await to.getByLabel('Claude Code').check();
  await page.getByPlaceholder(/Message Claude Code to carry on/).fill('Now deny the next one');
  await chatPane.getByRole('button', { name: 'Send', exact: true }).click();
  const ask2 = chatPane.getByRole('group', { name: /Claude Code asks/ }).last();
  await expect(ask2.getByRole('button', { name: 'Deny' })).toBeVisible();
  await ask2.getByRole('button', { name: 'Deny' }).click();
  await expect(chatPane).toContainText('You declined the command, so I stopped there.');
  await page.locator('.bottom').screenshot({ path: 'qa/results/claude-code-chat.png' });

  // its usage counts for the stream
  await expect.poll(async () => ((await api.get('/api/audit')).json as any[]).filter((a) => a.action === 'claudecode.denied').length).toBe(1);
  await page.goto(`${WEB}/settings?section=claudecode`);
  await expect(page.getByText('How it\'s kept safe')).toBeVisible();
  await setCc(false);
});

test('Settings → Claude Code: CLAUDE.md toggle and a skills picker (none / all / ticked)', async ({ page }) => {
  await page.goto(`${WEB}/settings?section=claudecode`);
  await expect(page.getByText('Give Claude Code my CLAUDE.md instructions')).toBeVisible();
  const skills = page.getByRole('radiogroup', { name: 'Skills' });
  await expect(skills.getByLabel('None')).toBeChecked(); // default
  await skills.getByLabel('Only the ones I tick').check();
  await expect(skills.getByLabel('Only the ones I tick')).toBeChecked(); // stays, even with nothing ticked yet
  await expect(page.getByLabel('Your skills')).toBeVisible();
  await page.locator('.settings-body').screenshot({ path: 'qa/results/claude-code-settings.png' });
  await page.getByText('Give Claude Code my CLAUDE.md instructions').click();
  await skills.getByLabel("All (yours and the project's)").check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(async () => {
    const c = (await api.get('/api/settings')).json.claudeCode;
    return [c.loadClaudeMd, c.skills];
  }).toEqual([true, 'all']);
});

test("Claude's own hand-off offer starts Claude Code here when it's on (not Terminal)", async ({ page }) => {
  await setCc(true);
  const { demoDataDir } = await import('./helpers');
  const sid = (await api.post('/api/streams', { title: 'Offer here stream', summary: '' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  const meta = { handoffOffer: { task: 'Write the export script', done: [] }, suggestion: { instruction: 'Write the export script', status: 'open' } };
  db.prepare('insert into chat_messages (id, stream_id, role, content, meta, created_at) values (?,?,?,?,?,?)').run('offer-here', sid, 'suggestion', 'This needs code. Hand it to Claude Code?', JSON.stringify(meta), new Date().toISOString());
  db.close();
  await page.goto(WEB);
  await stream(page, /Offer here stream/).click();
  const bubble = page.locator('.handoff-offer');
  await bubble.getByRole('button', { name: 'Hand off to Claude Code' }).click();
  await expect(bubble).toContainText('Handed off to Claude Code');
  await expect.poll(async () => (await api.get(`/api/streams/${sid}/claude-code`)).json.session?.state ?? 'none').not.toBe('none');
  // it ran here: a Run-here session, and no Terminal hand-off recorded
  expect((await api.get(`/api/streams/${sid}/handoff`)).json.last).toBeNull(); // a Terminal hand-off would be recorded here
  await expect(page.locator('.chat')).toContainText('Claude Code');
  await setCc(false);
});

test('an offer for something you asked for yourself has no "I\'m looking into it" button', async ({ page }) => {
  const { demoDataDir } = await import('./helpers');
  const sid = (await api.post('/api/streams', { title: 'Own ask stream', summary: '' })).json.id;
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  const meta = { handoffOffer: { task: 'Fix the macro in the budget sheet', done: [], noReply: true }, suggestion: { instruction: 'x', status: 'open' } };
  db.prepare('insert into chat_messages (id, stream_id, role, content, meta, created_at) values (?,?,?,?,?,?)').run('offer-own', sid, 'suggestion', 'I can\'t edit Sheets, but Claude Code can. Hand it over?', JSON.stringify(meta), new Date().toISOString());
  db.close();
  await page.goto(WEB);
  await stream(page, /Own ask stream/).click();
  const bubble = page.locator('.handoff-offer');
  await expect(bubble.getByRole('button', { name: 'Hand off to Claude Code' })).toBeVisible();
  await expect(bubble.getByRole('button', { name: /looking into it/ })).toHaveCount(0);
});
