import path from 'node:path';
import { test, expect, freshApp, api, demoDataDir, stream, WEB } from './helpers';

freshApp();

/** The demo's first ticket (created by approving its ticket draft), and the stream it lives in. */
async function demoTicket() {
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
  const failed = (await api.waitStatus(id, 'failed')) as any;
  expect(failed.error).toMatch(/Write a message first/);
});
