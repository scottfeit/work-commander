import { test, expect, freshApp, api, stream, watchPage, WEB } from './helpers';

freshApp();

test('rejecting the ticket makes the dependent email fail with a clear reason, and Claude is told', async ({ page }) => {
  const problems = watchPage(page);
  const [ticket, mail] = await api.waitPending(['ticket_create', 'email_reply']);
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();

  const t = page.locator('.draft.kind-ticket_create');
  await t.getByRole('button', { name: /^reject/i }).click();
  // Approve, Reject and Cancel stay in one row; only the "why?" box opens on a new line below them.
  const approve = t.getByRole('button', { name: /approve/i });
  const rejectBtn = t.getByRole('button', { name: /^reject$/i });
  const cancel = t.getByRole('button', { name: /^cancel$/i });
  const why = t.getByPlaceholder(/why/i);
  await expect(approve).toBeVisible();
  await expect(why).toBeVisible();
  await expect(cancel).toBeVisible();
  const [a, r, c, w] = await Promise.all([approve.boundingBox(), rejectBtn.boundingBox(), cancel.boundingBox(), why.boundingBox()]);
  expect(Math.abs(r!.y - a!.y)).toBeLessThan(4); // Reject on Approve's line
  expect(Math.abs(c!.y - a!.y)).toBeLessThan(4); // so is Cancel
  expect(c!.x).toBeGreaterThan(r!.x); // Cancel right after Reject
  expect(w!.y).toBeGreaterThan(a!.y + a!.height - 1); // the text box is below the buttons
  await cancel.click(); // Cancel closes the box and Reject goes back to opening it
  await expect(why).toHaveCount(0);
  await t.getByRole('button', { name: /^reject/i }).click();
  await t.getByPlaceholder(/why/i).fill('QA: not needed');
  await t.getByRole('button', { name: /^reject$/i }).click();
  await expect(t).toHaveCount(0);

  const rejected = (await api.proposals()).find((p) => p.id === ticket.id)!;
  expect(rejected.status).toBe('rejected');

  // The email still waits for the PU; approving it must not send anything with an unresolved {{ticket.key}}.
  await page.locator('.draft.kind-email_reply').getByRole('button', { name: /approve/i }).click();
  const done = await api.waitStatus(mail.id, 'failed');
  expect(done.error).toMatch(/depends on|rejected|failed/i);
  expect(JSON.stringify(done.payload)).toContain('{{ticket.key}}'); // never sent
  // The failure is visible to the PU (toast or chat), not silent.
  await expect(page.locator('.toast, .toasts, .chat-scroll, .sys-note').first()).toBeVisible();
  // Claude acknowledges the rejection in the chat.
  await expect(page.locator('.chat-scroll')).toContainText(/left those undone|understood|rejected/i, { timeout: 20_000 });
  expect(problems.filter((p) => !/\b4\d\d\b/.test(p)), problems.join('\n')).toEqual([]);
});
