import { test, expect, freshApp, stream, WEB } from './helpers';

freshApp();

// A wide font stands in for Gibson (the brand font, when it's installed), at normal and larger text.
for (const zoom of [1, 1.2]) {
  test(`work stream card buttons stay on one line with a wide font at ${zoom * 100}% text`, async ({ page }) => {
    await page.goto(WEB);
    await page.addStyleTag({ content: `:root { --sans: Verdana, sans-serif !important; } html { zoom: ${zoom}; }` });
    await stream(page, /contractor access/i).click();
    await page.waitForTimeout(300);
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.sidebar .stream')].flatMap((card) => {
        const btns = [...card.querySelectorAll('button.btn')] as HTMLElement[];
        if (btns.length < 2) return [];
        const mids = new Set(btns.map((b) => { const r = b.getBoundingClientRect(); return Math.round(r.top + r.height / 2); }));
        const box = card.getBoundingClientRect();
        const inside = btns.every((b) => b.getBoundingClientRect().right <= box.right + 1);
        const cut = btns.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent);
        return [{ card: (card.textContent ?? '').slice(0, 20), lines: mids.size, inside, cut }];
      }),
    );
    for (const r of rows) {
      expect(r.lines, r.card).toBe(1);
      expect(r.inside, r.card).toBe(true);
      if (zoom === 1) expect(r.cut, r.card).toEqual([]); // at normal size every label shows whole
    }
    await page.locator('.sidebar').screenshot({ path: `qa/results/card-buttons-${zoom}.png`, clip: { x: 0, y: 150, width: 300, height: 280 } });
  });
}
