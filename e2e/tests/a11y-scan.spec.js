// Automated WCAG 2.1 A/AA scan (axe-core) of the viewer's main screens.
// The map canvas itself is excluded: it's a WebGL image with its own keyboard
// alternative (search), and axe can't evaluate pixels in it.
const { test, expect, gotoViewer, selectParcelViaSearch, ui, openMapControlsTab } = require('./fixtures');
const AxeBuilder = require('@axe-core/playwright').default;

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page, label) {
  // Let entry animations finish: mid-fade, axe measures a blended (lighter) text colour.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const res = await new AxeBuilder({ page }).withTags(TAGS).exclude('canvas.maplibregl-canvas').analyze();
  const summary = res.violations.map((v) => ({
    id: v.id, impact: v.impact, count: v.nodes.length,
    targets: v.nodes.slice(0, 4).map((n) => n.target.join(' ')),
    detail: v.nodes[0] && v.nodes[0].failureSummary.split('\n').slice(0, 3).join(' | '),
  }));
  if (summary.length) console.log(`\n[a11y] ${label}:\n` + JSON.stringify(summary, null, 1));
  return summary;
}

const SCREENS = {
  'initial load': async () => {},
  'parcel selected': async (page) => { await selectParcelViaSearch(page); },
  'settings dialog': async (page) => {
    await ui.helpMenuButton(page).click();
    await ui.helpMenu(page).getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' }).getByLabel('Area units')).toBeVisible();
  },
  'map buddy open': async (page) => {
    await ui.mapBuddyButton(page).click();
    await page.waitForTimeout(800);
  },
  'layers panel': async (page) => {
    await openMapControlsTab(page, 'Layers');
  },
  'right-click menu': async (page) => {
    const box = await ui.mapCanvas(page).boundingBox();
    await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.4, { button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
  },
  'right-click menu, dark': async (page) => {
    await page.getByRole('button', { name: 'Toggle dark mode' }).click();
    const box = await ui.mapCanvas(page).boundingBox();
    await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.4, { button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
  },
  'dark mode + parcel': async (page) => {
    await page.getByRole('button', { name: 'Toggle dark mode' }).click();
    await selectParcelViaSearch(page);
  },
};

for (const [label, prep] of Object.entries(SCREENS)) {
  test(`a11y: ${label}`, async ({ page }) => {
    await gotoViewer(page);
    await prep(page);
    const v = await scan(page, label);
    // Serious/critical violations fail; minor/moderate are reported in the log.
    expect(v.filter((x) => x.impact === 'serious' || x.impact === 'critical'), JSON.stringify(v, null, 1)).toEqual([]);
  });
}

test('a11y: admin console', async ({ page }) => {
  await page.goto('/admin/');
  await page.waitForLoadState('networkidle');
  const v = await scan(page, 'admin console');
  expect(v.filter((x) => x.impact === 'serious' || x.impact === 'critical'), JSON.stringify(v, null, 1)).toEqual([]);
});
