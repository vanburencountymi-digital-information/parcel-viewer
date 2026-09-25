// Phone viewport (Pixel 7): the mobile tab bar, search overlay and parcel panel work.
const { test, expect, gotoViewer } = require('./fixtures');

test('mobile: tab bar, search overlay, select a parcel', async ({ page }) => {
  await gotoViewer(page);
  await expect(page.locator('#pv-mobile-tabbar')).toBeVisible();
  await page.locator('#pv-search-btn').click();
  const input = page.locator('#parcel-search-input');
  await expect(input).toBeVisible();
  await input.fill('paw paw');
  const first = page.locator('.parcel-search-result').first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page.locator('#parcel-info-panel')).toBeVisible();
  // No horizontal overflow on a phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('mobile: each bottom tab opens its panel', async ({ page }) => {
  await gotoViewer(page);
  for (const id of ['pv-mtab-controls', 'pv-mtab-buddy', 'pv-mtab-parcel']) {
    const tab = page.locator('#' + id);
    if (!(await tab.isVisible()) || await tab.isDisabled()) continue;
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }
});

test('mobile: no serious WCAG 2.1 AA violations (load, search, parcel)', async ({ page }) => {
  const AxeBuilder = require('@axe-core/playwright').default;
  const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
  const scan = async (label) => {
    const r = await new AxeBuilder({ page }).withTags(TAGS).exclude('canvas.maplibregl-canvas').analyze();
    const v = r.violations.map((x) => ({ id: x.id, impact: x.impact, targets: x.nodes.slice(0, 4).map((n) => n.target.join(' ')),
      detail: x.nodes[0] && x.nodes[0].failureSummary.split('\n').slice(0, 3).join(' | ') }));
    if (v.length) console.log(`\n[a11y mobile] ${label}:\n` + JSON.stringify(v, null, 1));
    return v.filter((x) => x.impact === 'serious' || x.impact === 'critical');
  };
  await gotoViewer(page);
  expect(await scan('load')).toEqual([]);
  await page.locator('#pv-search-btn').click();
  await page.locator('#parcel-search-input').fill('paw paw');
  await expect(page.locator('.parcel-search-result').first()).toBeVisible();
  expect(await scan('search results')).toEqual([]);
  await page.locator('.parcel-search-result').first().click();
  await expect(page.locator('#parcel-info-panel')).toBeVisible();
  expect(await scan('parcel panel')).toEqual([]);
});
