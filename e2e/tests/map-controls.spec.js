// Map Controls panel: every Select / Measure / Draw tool can be armed from its button and
// exited again (Esc or its own control), always releasing the map-click gate.
const { test, expect, gotoViewer, clickGate } = require('./fixtures');

async function openTab(page, tab) {
  const panel = page.locator('#map-control-panel');
  if (!(await panel.isVisible())) await page.locator('#mcp-reopen-tab').click();
  await expect(panel).toBeVisible();
  const btn = page.locator(`.mcp-tab[data-tab="${tab}"]`);
  if (!(await btn.isVisible())) await page.locator('#mcp-advanced-toggle').click();
  await btn.click();
  await expect(page.locator(`#mcp-pane-${tab}`)).toBeVisible();
}

test.beforeEach(async ({ page }) => { await gotoViewer(page); });

test.describe('Select tools', () => {
  for (const id of ['tool-box-select', 'tool-lasso', 'tool-buffer', 'tool-filter']) {
    test(`${id}: arms and exits`, async ({ page }) => {
      await openTab(page, 'select');
      await page.locator('#' + id).click();
      const bar = page.locator('#tool-active-bar');
      if (await bar.isVisible()) {
        await page.locator('#exit-tool-btn').click();
        await expect(bar).toBeHidden();
      } else {
        await page.keyboard.press('Escape');
      }
      expect(await clickGate(page)).toBeNull();
    });
  }
});

test.describe('Measure tools', () => {
  const TOOLS = ['msr-tool-area', 'msr-tool-dist', 'msr-tool-coords', 'msr-tool-dimline', 'msr-tool-autodim'];
  const ADVANCED = ['msr-tool-bearing', 'msr-tool-perp', 'msr-tool-arc', 'msr-tool-running', 'msr-tool-angle'];
  for (const id of TOOLS.concat(ADVANCED)) {
    test(`${id}: arms (holds the gate) and Esc / re-click exits`, async ({ page }) => {
      await openTab(page, 'measure');
      const btn = page.locator('#' + id);
      if (!(await btn.isVisible())) await page.locator('#msr-adv-toggle').click();
      await btn.click();
      expect(await clickGate(page), 'tool armed').toBe('measure');
      await btn.click();                                  // toggle off
      if (await clickGate(page)) await page.keyboard.press('Escape');
      expect(await clickGate(page), 'tool released').toBeNull();
      await expect(page.locator('#msr-hud')).toBeHidden();
    });
  }
});

test.describe('Draw tools', () => {
  for (const tool of ['point', 'polyline', 'polygon', 'circle', 'freehand', 'text', 'callout', 'select']) {
    test(`${tool}: arms and Esc exits`, async ({ page }) => {
      await openTab(page, 'draw');
      await page.locator('#drw-tool-' + tool).click();
      expect(await clickGate(page)).toBe(tool);
      await page.keyboard.press('Escape');
      expect(await clickGate(page), 'Esc exits the draw tool').toBeNull();
      expect(await page.evaluate(() => window.PS_MAP.dragPan.isEnabled()), 'panning restored').toBe(true);
    });
  }

  test('leaving the Draw tab exits drawing', async ({ page }) => {
    await openTab(page, 'draw');
    await page.locator('#drw-tool-polygon').click();
    await openTab(page, 'layers');
    expect(await clickGate(page)).toBeNull();
  });
});
