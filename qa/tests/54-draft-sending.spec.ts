import path from 'node:path';
import { test, expect, freshApp, api, demoDataDir, stream, WEB } from './helpers';

freshApp();

/** A Slack draft in the demo's first stream, in the given state (written straight into the demo database). */
async function slackDraft(status: string, title: string, error: string | null = null) {
  const { default: SQLite } = await import('better-sqlite3');
  const [first] = (await api.streams()) as any[];
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  const id = `qa-send-${Date.now()}`;
  const payload = JSON.stringify({ channel: 'C1', text: 'A long message', quick: false });
  db.prepare("insert into proposals (id, stream_id, run_id, kind, system, title, rationale, payload, original_payload, editable, depends_on, status, error, created_at) values (?,?,?,?,?,?,?,?,?,?,'[]',?,?,?)").run(
    id, first.id, 'qa', 'slack_post', 'slack', title, 'Asked in chat', payload, payload, JSON.stringify([{ key: 'text', label: 'Message', type: 'textarea' }]), status, error, new Date().toISOString(),
  );
  db.close();
  return { id, streamTitle: first.title as string, streamId: first.id as string };
}
const setStatus = async (id: string, status: string, error: string | null) => {
  const { default: SQLite } = await import('better-sqlite3');
  const db = new SQLite(path.join(demoDataDir(), 'work-commander.sqlite'));
  db.prepare('update proposals set status = ?, error = ? where id = ?').run(status, error, id);
  db.close();
};
const open = async (page: any, title: string) => {
  await page.goto(WEB);
  await stream(page, new RegExp(title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).click();
};

test('a draft that is being sent stays in the Drafts pane with a moving bar, and cannot be edited or sent again', async ({ page }) => {
  const d = await slackDraft('executing', 'Slack: post in #sending-one');
  await open(page, d.streamTitle);
  const card = page.locator('.draft.sending', { hasText: 'post in #sending-one' });
  await expect(card).toBeVisible();
  await expect(card.locator('.sending-bar')).toBeVisible();
  await expect(card.getByRole('status')).toContainText(/Sending/);
  await expect(card.getByRole('button', { name: /send/i })).toHaveCount(0); // no Approve & send, no Reject while it goes
  await card.screenshot({ path: 'qa/results/draft-sending.png' });
});

test('a draft that could not be sent is back to waiting, with the reason beside its buttons and no moving bar', async ({ page }) => {
  const d = await slackDraft('pending', 'Slack: post in #failed-two', 'Slack did not answer within 20 seconds');
  await open(page, d.streamTitle);
  const card = page.locator('.draft', { hasText: 'post in #failed-two' });
  await expect(card).toBeVisible();
  await expect(card.locator('.sending-bar')).toHaveCount(0);
  await expect(card.locator('.send-error')).toContainText(/Slack did not answer.*Nothing was sent/);
  await expect(card.getByRole('button', { name: 'Approve & send' })).toBeEnabled(); // ready to try again
  await card.screenshot({ path: 'qa/results/draft-send-failed.png' });
  // sending shows the bar again, and the old reason is gone while it goes
  await setStatus(d.id, 'executing', null);
  await page.reload();
  await open(page, d.streamTitle);
  await expect(page.locator('.draft.sending', { hasText: 'post in #failed-two' })).toBeVisible();
  await expect(page.locator('.draft.sending .send-error')).toHaveCount(0);
});
