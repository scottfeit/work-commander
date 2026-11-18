import { test, expect, freshApp, api, stream, WEB } from './helpers';

freshApp();

test('the Overview is a pane beside the work item, about a third wide, resizable by dragging the line', async ({ page }) => {
  await api.post('/api/streams', { title: 'Overview pane stream', summary: 'Pane summary text' });
  await page.goto(WEB);
  await page.evaluate(() => localStorage.removeItem('wc.ovSplit'));
  await page.reload();
  await stream(page, /overview pane stream/i).click();
  const pane = page.locator('.overview-pane');
  await expect(pane.locator('.summary-input')).toHaveValue('Pane summary text');
  await expect(page.locator('.tabbar [role=tab]', { hasText: 'Overview' })).toHaveCount(0); // no longer a tab
  await expect(page.locator('.top-pane')).toContainText(/no work items in this stream yet/i);

  const area = (await page.locator('.work-area').boundingBox())!;
  const w0 = (await pane.boundingBox())!.width;
  expect(w0 / area.width).toBeGreaterThan(0.28);
  expect(w0 / area.width).toBeLessThan(0.38);

  // drag the line left: the Overview gets wider, and stays that way after a reload
  const line = (await page.locator('.divider-v').boundingBox())!;
  await page.mouse.move(line.x + line.width / 2, line.y + 40);
  await page.mouse.down();
  await page.mouse.move(line.x - 150, line.y + 40, { steps: 5 });
  await page.mouse.up();
  const w1 = (await pane.boundingBox())!.width;
  expect(w1).toBeGreaterThan(w0 + 100);
  await page.reload();
  await stream(page, /overview pane stream/i).click();
  expect(Math.abs((await pane.boundingBox())!.width - w1)).toBeLessThan(4);

  // double-click resets it
  await page.locator('.divider-v').dblclick();
  expect(Math.abs((await pane.boundingBox())!.width - w0)).toBeLessThan(4);
  await page.locator('.overview-pane').screenshot({ path: 'qa/results/overview-pane.png' });
});

test('Show open (on by default) hides the Open and Pending work streams when unchecked', async ({ page }) => {
  const id = (await api.post('/api/streams', { title: 'Show open closed one', summary: '' })).json.id;
  await api.call('PATCH', `/api/streams/${id}`, { status: 'closed' });
  await api.post('/api/streams', { title: 'Show open still open', summary: '' });
  await page.goto(WEB);
  const showOpen = page.getByRole('checkbox', { name: 'Show open' });
  await expect(showOpen).toBeChecked();
  await expect(stream(page, /show open still open/i)).toBeVisible();
  await showOpen.uncheck();
  await expect(stream(page, /show open still open/i)).toHaveCount(0);
  await expect(page.locator('.section-label', { hasText: /^Open/ })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Show closed' }).check();
  await expect(stream(page, /show open closed one/i)).toBeVisible();
  await showOpen.check();
  await expect(stream(page, /show open still open/i)).toBeVisible();
});

test('Settings is a gear at the top right of the sidebar; the four list checkboxes sit in two columns', async ({ page }) => {
  await page.goto(WEB);
  const gear = page.locator('.brand').getByRole('button', { name: 'Settings' });
  const count = page.locator('.stream.general .muted');
  const [g, c] = await Promise.all([gear.boundingBox(), count.boundingBox()]);
  expect(g!.y + g!.height).toBeLessThanOrEqual(c!.y); // above the open count
  expect(Math.abs(g!.x + g!.width - (c!.x + c!.width))).toBeLessThan(24); // right-aligned with it
  expect(await gear.textContent()).toBe(''); // an icon, not the word
  const box = async (name: string) => (await page.getByRole('checkbox', { name }).boundingBox())!;
  const [o, p, cl, d] = await Promise.all(['Show open', 'Show pending', 'Show closed', 'Show declined'].map(box));
  expect(Math.abs(o.x - p.x)).toBeLessThan(2); // column 1
  expect(Math.abs(cl.x - d.x)).toBeLessThan(2); // column 2
  expect(cl.x).toBeGreaterThan(o.x + 40);
  expect(Math.abs(o.y - cl.y)).toBeLessThan(2) // rows line up
  expect(p.y).toBeGreaterThan(o.y);
  await page.locator('.sidebar').screenshot({ path: 'qa/results/sidebar.png' });
  await gear.click();
  await expect(page).toHaveURL(/\/settings/);
});

test('the Claude and Drafts panes resize into each other by dragging the line between them; double-click puts them back to 50/50', async ({ page }) => {
  await api.waitPending(['ticket_create', 'email_reply']);
  await page.goto(WEB);
  await page.evaluate(() => localStorage.removeItem('wc.draftSplit'));
  await page.reload();
  await stream(page, /contractor access/i).click();
  const chat = page.locator('.bottom > .chat, .bottom > :first-child').first();
  const drafts = page.locator('.bottom .drafts');
  const line = page.getByRole('separator', { name: 'Resize the Drafts pane' });
  await expect(drafts).toBeVisible();
  const widths = async () => [(await chat.boundingBox())!.width, (await drafts.boundingBox())!.width];
  const [c0, d0] = await widths();
  expect(Math.abs(c0 - d0)).toBeLessThan(4); // 50/50 to start

  // drag left: Drafts grows into the chat; it stays after a reload
  const b = (await line.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 60);
  await page.mouse.down();
  await page.mouse.move(b.x - 250, b.y + 60, { steps: 6 });
  await page.mouse.up();
  const [c1, d1] = await widths();
  expect(d1).toBeGreaterThan(d0 + 200);
  expect(c1).toBeLessThan(c0 - 200);
  await page.reload();
  await stream(page, /contractor access/i).click();
  expect(Math.abs((await drafts.boundingBox())!.width - d1)).toBeLessThan(4);

  // and the other way, into the drafts
  const b2 = (await line.boundingBox())!;
  await page.mouse.move(b2.x + b2.width / 2, b2.y + 60);
  await page.mouse.down();
  await page.mouse.move(b2.x + 500, b2.y + 60, { steps: 6 });
  await page.mouse.up();
  expect((await widths())[0]).toBeGreaterThan(c0 + 150);
  await page.locator('.bottom').screenshot({ path: 'qa/results/drafts-resize.png' });

  // double-click: back to 50/50
  await line.dblclick();
  const [c2, d2] = await widths();
  expect(Math.abs(c2 - d2)).toBeLessThan(4);
});

test('the tab bar runs the full width, to the right edge; the Overview pane sits below it', async ({ page }) => {
  await page.goto(WEB);
  await stream(page, /contractor access/i).click();
  const [bar, area, ov, item] = await Promise.all([page.locator('.work-area > .tabbar').boundingBox(), page.locator('.work-area').boundingBox(), page.locator('.overview-pane').boundingBox(), page.locator('.top-pane').boundingBox()]);
  expect(Math.abs(bar!.x + bar!.width - (area!.x + area!.width))).toBeLessThan(2);
  expect(Math.abs(bar!.x - area!.x)).toBeLessThan(2);
  expect(ov!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);
  expect(Math.abs(ov!.y - item!.y)).toBeLessThan(2); // the item and the Overview start at the same height
  await page.locator('.work-area').screenshot({ path: 'qa/results/tabbar-full-width.png' });
});
