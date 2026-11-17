import { test, expect, freshApp, api, WEB } from './helpers';

freshApp();

test('Settings → Rules: add a rule that files matching mail into a work stream, reorder, turn off, delete', async ({ page }) => {
  const id = (await api.post('/api/streams', { title: 'Rules target stream', summary: '' })).json.id;
  await page.goto(`${WEB}/settings?section=rules`);
  await expect(page.getByText('No rules yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Add rule' }).click();
  const r1 = page.getByRole('group', { name: 'Rule 1' });
  await expect(r1).toContainText('an empty rule is never applied');
  await r1.getByLabel('Source').selectOption('gmail');
  await r1.getByLabel('From contains').fill('@vendor.com');
  await r1.getByLabel('Subject contains').fill('invoice');
  await r1.getByLabel('Action').selectOption(`stream:${id}`);
  await expect(r1).not.toContainText('an empty rule is never applied');
  await page.getByRole('button', { name: 'Add rule' }).click();
  const r2 = page.getByRole('group', { name: 'Rule 2' });
  await r2.getByLabel('Text contains').fill('unsubscribe');
  await page.locator('.settings-body').screenshot({ path: 'qa/results/rules.png' });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  let rules = (await api.get('/api/settings')).json.rules;
  expect(rules).toMatchObject([
    { source: 'gmail', from: '@vendor.com', subject: 'invoice', action: 'stream', streamId: id },
    { source: 'any', text: 'unsubscribe', action: 'ignore' },
  ]);

  await r2.getByRole('button', { name: 'Move rule up' }).click();
  await page.getByRole('group', { name: 'Rule 2' }).getByLabel('Rule on', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  rules = (await api.get('/api/settings')).json.rules;
  expect(rules.map((r: any) => [r.text ?? r.subject, r.enabled])).toEqual([
    ['unsubscribe', undefined],
    ['invoice', false],
  ]);

  await page.getByRole('group', { name: 'Rule 1' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(async () => (await api.get('/api/settings')).json.rules.length).toBe(1);
});
