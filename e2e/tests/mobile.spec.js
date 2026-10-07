// Phone viewport (Pixel 7): the mobile tab bar, search overlay and parcel panel work.
const { test, expect, gotoViewer, ui } = require('./fixtures');

const searchBtn = (page) => page.getByRole('button', { name: 'Search parcels', exact: true });
const firstResult = (page) => ui.searchResults(page).getByRole('option').first();

test('mobile: tab bar, search overlay, select a parcel', async ({ page }) => {
  await gotoViewer(page);
  await expect(page.getByRole('tablist', { name: 'Panels' })).toBeVisible();
  await searchBtn(page).click();
  const input = ui.searchInput(page);
  await expect(input).toBeVisible();
  await input.fill('paw paw');
  const first = firstResult(page);
  await expect(first).toBeVisible();
  await first.click();
  await expect(ui.parcelPanel(page)).toBeVisible();
  // No horizontal overflow on a phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('mobile: each bottom tab opens its panel', async ({ page }) => {
  await gotoViewer(page);
  const tabs = page.getByRole('tablist', { name: 'Panels' });
  for (const name of ['Map Controls', 'MapBuddy A.I.', 'Parcel Info']) {
    const tab = tabs.getByRole('tab', { name, exact: true });
    if (!(await tab.isVisible()) || await tab.isDisabled()) continue;
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }
});

test('mobile: no serious WCAG 2.1 AA violations (load, search, parcel)', async ({ page }) => {
  const AxeBuilder = require('@axe-core/playwright').default;
  const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
  const scan = async (label) => {
    // Let entry animations finish: mid-fade, axe measures a blended (lighter) text colour
    // and reports contrast the settled page doesn't have.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    const r = await new AxeBuilder({ page }).withTags(TAGS).exclude('canvas.maplibregl-canvas').analyze();
    const v = r.violations.map((x) => ({ id: x.id, impact: x.impact, targets: x.nodes.slice(0, 4).map((n) => n.target.join(' ')),
      detail: x.nodes[0] && x.nodes[0].failureSummary.split('\n').slice(0, 3).join(' | ') }));
    if (v.length) console.log(`\n[a11y mobile] ${label}:\n` + JSON.stringify(v, null, 1));
    return v.filter((x) => x.impact === 'serious' || x.impact === 'critical');
  };
  await gotoViewer(page);
  expect(await scan('load')).toEqual([]);
  await searchBtn(page).click();
  await ui.searchInput(page).fill('paw paw');
  await expect(firstResult(page)).toBeVisible();
  expect(await scan('search results')).toEqual([]);
  await firstResult(page).click();
  await expect(ui.parcelPanel(page)).toBeVisible();
  expect(await scan('parcel panel')).toEqual([]);
});
