import path from 'node:path';
import { test, expect, freshApp, api, demoDataDir, stream, WEB } from './helpers';

freshApp();

/** The demo's first ticket (created by approving its ticket draft), and the stream it lives in. */
async function demoTicket() {
  // the demo has one ticket draft: an earlier test in this file may have approved it already
  const made = (await api.proposals()).find((p: any) => p.kind === 'ticket_create' && p.status === 'executed') as any;
  if (made) return { key: made.result.key as string, streamId: made.streamId as string };
  const [ticket] = await api.waitPending(['ticket_create']);
  await api.post(`/api/proposals/${ticket.id}/approve`);
  const done = await api.waitStatus(ticket.id, 'executed');
  return { key: (done as any).result.key as string, streamId: ticket.streamId as string };
}

/** A draft as Claude's propose_* tool would make it. */
function insertProposal(streamId: string, kind: string, title: string, payload: Record<string, unknown>, editable: unknown[]) {
  return import('better-sqlite3').then(({ default: SQLite }) => {
    const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
    const id = `qa-${kind}-${Date.now()}`;
    const p = JSON.stringify(payload);
    db.prepare("insert into proposals (id, stream_id, run_id, kind, system, title, rationale, payload, original_payload, editable, depends_on, status, created_at) values (?,?,?,?,?,?,?,?,?,?,'[]','pending',?)").run(id, streamId, 'qa', kind, 'atlassian', title, 'Asked in chat', p, p, JSON.stringify(editable), new Date().toISOString());
    db.close();
    return id;
  });
}

test('Claude can link Jira issues: a draft you approve', async ({ page }) => {
  const { key, streamId } = await demoTicket();
  const id = await insertProposal(streamId, 'ticket_link', `Link IT-123, IT-124 → ${key}`, { keys: ['IT-123', 'IT-124'], to_key: key, relation: 'relates to' }, [
    { key: 'keys', label: 'Issues', type: 'list' },
    { key: 'relation', label: 'Relation', type: 'text' },
    { key: 'to_key', label: 'Linked to', type: 'text' },
  ]);
  await page.goto(WEB);
  const s = (await api.streams()).find((x: any) => x.id === streamId);
  await stream(page, new RegExp(s.title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).click();
  const card = page.locator('.draft', { hasText: 'Link IT-123' });
  await expect(card).toBeVisible();
  await card.screenshot({ path: 'qa/results/jira-link-draft.png' });
  await api.post(`/api/proposals/${id}/approve`);
  const done = (await api.waitStatus(id, 'executed')) as any;
  expect(done.result.linked).toEqual([`IT-123 relates to ${key}`, `IT-124 relates to ${key}`]);
});

test('email drafts end with the Gmail signature (Quick Reply too)', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  await page.locator('.top-pane .item-head').getByRole('button', { name: 'Quick reply' }).click();
  const draft = page.locator('.draft', { hasText: 'Quick reply' });
  const body = draft.locator('textarea').first();
  await expect(body).toHaveValue(/\n\nAlex Rivera\nIT Operations, Acme · acme\.example$/);
  await draft.screenshot({ path: 'qa/results/signature-draft.png' });
  // a Quick Reply holding only the signature is still blank: it can't be sent
  const id = (await api.proposals()).find((p: any) => p.payload.quick && p.kind === 'email_reply')!.id;
  await api.post(`/api/proposals/${id}/approve`);
  // ...so it goes back to waiting, with the reason beside its buttons, ready to be written and sent
  const waiting = (await api.proposals()).find((p: any) => p.id === id) as any;
  expect(waiting.status).toBe('pending');
  expect(waiting.error).toMatch(/Write a message first/);
  await page.reload();
  await stream(page, /contractor access/i).click();
  await expect(page.locator('.draft', { hasText: 'Quick reply' }).locator('.send-error')).toContainText(/Write a message first/);
});

test('a Jira/JSM item has a status drop-down: moves right away, asks for a Resolution when needed, Undo moves it back', async ({ page }) => {
  const { key, streamId } = await demoTicket();
  await page.goto(WEB);
  const s = (await api.streams()).find((x: any) => x.id === streamId);
  await stream(page, new RegExp(s.title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).click();
  await page.getByText(new RegExp(`^${key}`)).first().click();
  const status = page.locator('.ticket-fields').getByLabel('Status');
  await status.selectOption({ label: 'In Progress' });
  await expect(status.locator('option').first()).toHaveText('In Progress');
  // Resolved needs a Resolution: a small box asks first
  await status.selectOption({ label: 'Resolved' });
  const ask = page.getByRole('group', { name: 'Moving to Resolved' });
  await ask.getByRole('combobox').selectOption({ label: "Won't Do" });
  await page.screenshot({ path: 'qa/results/jira-status.png', clip: { ...(await page.locator('.ticket-fields').boundingBox())!, height: 130 } });
  await ask.getByRole('button', { name: 'Move to Resolved' }).click();
  await expect(status.locator('option').first()).toHaveText('Resolved');
  // Undo moves it back
  await page.locator('.brand').getByRole('button', { name: /^Undo/ }).click();
  await expect(status.locator('option').first()).toHaveText('In Progress');
});

test('Copy link puts the ticket address on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { key, streamId } = await demoTicket();
  await page.goto(WEB);
  const s = (await api.streams()).find((x: any) => x.id === streamId);
  await stream(page, new RegExp(s.title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).click();
  await page.getByText(new RegExp(`^${key}`)).first().click();
  const jira = page.getByRole('group', { name: 'Jira' });
  await jira.getByRole('button', { name: 'Copy link' }).click();
  await expect(jira.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`https://example.atlassian.net/browse/${key}`);
});

test('Assign to me takes the ticket right away; Undo gives it back', async ({ page }) => {
  const { key, streamId } = await demoTicket();
  // someone else has it first
  const other = await insertProposal(streamId, 'ticket_assign', `Assign ${key} to Priya`, { key, assignee: 'priya.shah@example.com' }, []);
  await api.post(`/api/proposals/${other}/approve`);
  await api.waitStatus(other, 'executed');
  await page.goto(WEB);
  const s = (await api.streams()).find((x: any) => x.id === streamId);
  await stream(page, new RegExp(s.title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).click();
  await page.getByText(new RegExp(`^${key}`)).first().click();
  const assignee = page.locator('.ticket-fields div', { hasText: 'Assignee' }).locator('dd');
  await expect(assignee).toHaveText('priya.shah@example.com');
  await page.getByRole('group', { name: 'Jira' }).getByRole('button', { name: 'Assign to me' }).click();
  await expect(assignee).toHaveText('Alex Rivera');
  await page.locator('.top-pane .item-head').screenshot({ path: 'qa/results/jira-buttons.png' });
  await page.locator('.brand').getByRole('button', { name: /^Undo/ }).click();
  await expect(assignee).toHaveText('priya.shah@example.com');
});

test('a work item\'s buttons stay together on one line (moving under a long title) and inside the pane', async ({ page }) => {
  const { key, streamId } = await demoTicket();
  await page.goto(WEB);
  const s = (await api.streams()).find((x: any) => x.id === streamId);
  await stream(page, new RegExp(s.title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).click();
  await page.getByText(new RegExp(`^${key}`)).first().click();
  const row = page.locator('.top-pane .item-head-actions');
  // one line: every button's vertical middle is the same (they differ in height)
  const mids = await row.locator('> *').evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return b.top + b.height / 2; }));
  expect(Math.max(...mids) - Math.min(...mids)).toBeLessThan(4);
  const [r, pane] = await Promise.all([row.boundingBox(), page.locator('.top-pane .item-head').boundingBox()]);
  expect(r!.x + r!.width).toBeLessThanOrEqual(pane!.x + pane!.width + 1);
  await page.locator('.top-pane .item-head').screenshot({ path: 'qa/results/item-head-narrow.png' });
});

test('Claude can change the epic and the sprint: drafts you approve', async ({ page }) => {
  const { key, streamId } = await demoTicket();
  const epic = await insertProposal(streamId, 'ticket_epic', `Epic of ${key} → OPS-500`, { keys: [key], epic_key: 'OPS-500' }, [
    { key: 'keys', label: 'Issues', type: 'list' },
    { key: 'epic_key', label: 'Epic', type: 'text' },
  ]);
  const sprint = await insertProposal(streamId, 'ticket_sprint', `Sprint of ${key} → active`, { keys: [key], sprint: 'active' }, [
    { key: 'keys', label: 'Issues', type: 'list' },
    { key: 'sprint', label: 'Sprint', type: 'text' },
  ]);
  await page.goto(WEB);
  const s = (await api.streams()).find((x: any) => x.id === streamId);
  await stream(page, new RegExp(s.title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).click();
  await expect(page.locator('.draft', { hasText: 'Epic of' })).toBeVisible();
  // a change, not a message: "Approve", not "Approve & send"
  await expect(page.locator('.draft', { hasText: 'Epic of' }).getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  await expect(page.locator('.draft', { hasText: 'Reply:' }).getByRole('button', { name: 'Approve & send' })).toBeVisible();
  await page.locator('.draft', { hasText: 'Sprint of' }).screenshot({ path: 'qa/results/jira-sprint-draft.png' });
  await api.post(`/api/proposals/${epic}/approve`);
  await api.post(`/api/proposals/${sprint}/approve`);
  expect(((await api.waitStatus(epic, 'executed')) as any).result).toEqual({ epic: 'OPS-500', keys: [key] });
  expect(((await api.waitStatus(sprint, 'executed')) as any).result).toEqual({ sprint: 'OPS Sprint 12', keys: [key] });
});

test('in a narrow window with larger text, the less-used buttons fold into "More ▾" so the row stays on one line', async ({ page }) => {
  const { key, streamId } = await demoTicket();
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto(WEB);
  await page.addStyleTag({ content: 'html { zoom: 1.2; }' }); // larger text: 120%
  const s = (await api.streams()).find((x: any) => x.id === streamId);
  await stream(page, new RegExp(s.title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).click();
  await page.getByText(new RegExp(`^${key}`)).first().click();
  const row = page.locator('.top-pane .item-head-actions');
  await expect(row.getByRole('button', { name: 'More ▾' })).toBeVisible();
  const mids = await row.locator('> *').evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return b.top + b.height / 2; }));
  expect(Math.max(...mids) - Math.min(...mids)).toBeLessThan(4);
  const [r, pane] = await Promise.all([row.boundingBox(), page.locator('.top-pane .item-head').boundingBox()]);
  expect(r!.x + r!.width).toBeLessThanOrEqual(pane!.x + pane!.width + 1);
  // the menu holds both, and they work
  await row.getByRole('button', { name: 'More ▾' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Not relevant' })).toBeVisible();
  await page.screenshot({ path: 'qa/results/more-menu.png', clip: { ...(await page.locator('.top-pane .item-head').boundingBox())!, height: 200 } });
  await menu.getByRole('menuitem', { name: 'Ignore updates' }).click();
  await expect(menu).toHaveCount(0);
  await expect.poll(async () => (await api.get(`/api/streams/${streamId}/items`)).json.find((i: any) => i.title.startsWith(key))?.data.muted).toBe(true);
  // wide again: the buttons come back out
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.addStyleTag({ content: 'html { zoom: 1; }' });
  await expect(row.getByRole('button', { name: 'Unsilence' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'More ▾' })).toHaveCount(0);
});

test('the Overview folds Unread and Claude Code into "More ▾" when its buttons don\'t fit; the alarm and Close stay out', async ({ page }) => {
  const ov = page.locator('.overview-pane .ov-actions');
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  // normal size: everything out, no menu
  await expect(ov.getByRole('button', { name: 'Hand off to Claude Code' })).toBeVisible();
  await expect(ov.getByRole('button', { name: 'More ▾' })).toHaveCount(0);
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.addStyleTag({ content: 'html { zoom: 1.2; }' });
  await expect(ov.getByRole('button', { name: 'More ▾' })).toBeVisible();
  await expect(ov.getByRole('button', { name: 'Mark pending' })).toBeVisible();
  await expect(ov.getByRole('button', { name: 'Close stream' })).toBeVisible();
  // every button whole (none cut short) and inside the pane
  const cut = await ov.locator('.btn').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => `${e.textContent} ${e.scrollWidth}/${e.clientWidth}`));
  expect(cut).toEqual([]);
  const [r, pane] = await Promise.all([ov.boundingBox(), page.locator('.overview-pane').boundingBox()]);
  expect(r!.x + r!.width).toBeLessThanOrEqual(pane!.x + pane!.width + 1);
  await ov.getByRole('button', { name: 'More ▾' }).click();
  await page.locator('.overview-pane .item-head').screenshot({ path: 'qa/results/overview-more.png' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Hand off to Claude Code' }).click();
  await expect(page.locator('.overview-pane .handoff')).toBeVisible();
});

test('a draft that waits for another names it, even once that one is done', async ({ page }) => {
  const { streamId } = await demoTicket(); // the ticket draft is approved: the reply that ran after it named it by id before
  const ticket = (await api.proposals()).find((p: any) => p.kind === 'ticket_create')!;
  const id = await insertProposal(streamId, 'email_send', 'Email: follow-up', { to: ['a@b.c'], cc: [], subject: 'x', body: 'y' }, []);
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('update proposals set depends_on = ? where id = ?').run(JSON.stringify([ticket.id]), id);
  db.close();
  await page.goto(WEB);
  const s = (await api.streams()).find((x: any) => x.id === streamId);
  await stream(page, new RegExp(s.title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).click();
  const dep = page.locator('.draft', { hasText: 'Email: follow-up' }).locator('.dep');
  await expect(dep).toHaveText(`Runs after: ${ticket.title} (done)`);
  await expect(dep).not.toContainText('p_');
});

test('long ticket fields are cut with … and shown whole on hover; nothing spills into the next field', async ({ page }) => {
  const { key, streamId } = await demoTicket();
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto(WEB);
  await page.addStyleTag({ content: 'html { zoom: 1.2; }' });
  const s = (await api.streams()).find((x: any) => x.id === streamId);
  await stream(page, new RegExp(s.title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).click();
  await page.getByText(new RegExp(`^${key}`)).first().click();
  const req = page.locator('.ticket-fields div', { hasText: 'Requester' }).locator('dd');
  await expect(req).toHaveAttribute('title', /@example\.com$/);
  const box = await req.evaluate((e) => ({ over: e.scrollWidth > e.clientWidth, right: e.getBoundingClientRect().right, cell: e.parentElement!.getBoundingClientRect().right }));
  expect(box.right).toBeLessThanOrEqual(box.cell);
  const sel = await page.locator('.ticket-fields').getByLabel('Status').evaluate((e) => e.getBoundingClientRect().right <= e.closest('div')!.getBoundingClientRect().right);
  expect(sel).toBe(true);
  await page.locator('.ticket-fields').screenshot({ path: 'qa/results/ticket-fields-narrow.png' });
});

test('the Overview title shows in full on hover', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const t = page.locator('.overview-pane').getByLabel('Work stream title');
  await expect(t).toHaveAttribute('title', await t.inputValue());
  expect(await t.evaluate((e) => getComputedStyle(e).textOverflow)).toBe('ellipsis');
});

test("a JSM request's form shows under the description, question by question", async ({ page }) => {
  const { key, streamId } = await demoTicket();
  await page.goto(WEB);
  const s = (await api.streams()).find((x: any) => x.id === streamId);
  await stream(page, new RegExp(s.title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).click();
  await page.getByText(new RegExp(`^${key}`)).first().click();
  const form = page.getByRole('region', { name: 'Form: Access request' });
  await expect(form).toBeVisible();
  await expect(form.locator('dt').first()).toHaveText('What do you need?');
  await expect(form.locator('div', { hasText: 'Needed by' }).locator('dd')).toHaveText('—');
  // it sits below the description
  const desc = await page.locator('.top-pane .body.block').first().boundingBox();
  expect((await form.boundingBox())!.y).toBeGreaterThan(desc!.y);
  await form.screenshot({ path: 'qa/results/jsm-form.png' });
});

test('a ticket shows when it was created and last updated, just under its title', async ({ page }) => {
  const { key, streamId } = await demoTicket();
  await page.goto(WEB);
  const s = (await api.streams()).find((x: any) => x.id === streamId);
  await stream(page, new RegExp(s.title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).click();
  await page.getByText(new RegExp(`^${key}`)).first().click();
  const dates = page.locator('.ticket-dates');
  await expect(dates).toHaveText(/^Created [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M · Updated [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M$/);
  const title = await page.locator('.top-pane .item-head h2').boundingBox();
  const box = await dates.boundingBox();
  expect(box!.y).toBeGreaterThan(title!.y);
  expect(box!.y).toBeLessThan((await page.locator('.ticket-fields').boundingBox())!.y);
  await page.locator('.top-pane').screenshot({ path: 'qa/results/ticket-dates.png', clip: undefined });
});
