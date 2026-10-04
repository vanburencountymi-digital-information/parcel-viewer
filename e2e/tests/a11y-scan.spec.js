// Automated WCAG 2.1 A/AA scan (axe-core) of the viewer's main screens.
// The map canvas itself is excluded: it's a WebGL image with its own keyboard
// alternative (search), and axe can't evaluate pixels in it.
const { test, expect, gotoViewer, selectParcelViaSearch } = require('./fixtures');
const AxeBuilder = require('@axe-core/playwright').default;

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page, label) {
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
    await page.locator('#pv-admin-btn').click();
    await page.locator('#pv-admin-menu [data-tool="settings"]').click();
    await expect(page.locator('#pv-set-area')).toBeVisible();
  },
  'map buddy open': async (page) => {
    await page.locator('#mb-tab-btn').click();
    await page.waitForTimeout(800);
  },
  'layers panel': async (page) => {
    if (!(await page.locator('#map-control-panel').isVisible())) await page.locator('#mcp-reopen-tab').click();
    await page.locator('.mcp-tab[data-tab="layers"]').click();
  },
  'dark mode + parcel': async (page) => {
    await page.locator('#theme-toggle').click();
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
