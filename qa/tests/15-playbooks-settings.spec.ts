import { test, expect, freshApp, api, WEB } from './helpers';

freshApp();

test('Playbooks: write standing instructions and save them', async ({ page }) => {
  await page.goto(WEB + '/settings');
  await page.getByRole('button', { name: 'Playbooks' }).click();
  const box = page.getByRole('textbox', { name: 'Playbooks' });
  await expect(box).toHaveValue('');
  await box.fill('- When a Gainsight sync failure arrives, offer to add it to the tracking sheet.');
  await page.getByRole('button', { name: /save changes/i }).click();
  await expect(page.getByText(/settings saved/i)).toBeVisible();
  expect((await api.get('/api/settings')).json.playbooks).toBe('- When a Gainsight sync failure arrives, offer to add it to the tracking sheet.');
  await page.reload();
  await page.getByRole('button', { name: 'Playbooks' }).click();
  await expect(page.getByRole('textbox', { name: 'Playbooks' })).toHaveValue(/Gainsight sync failure/);
});
