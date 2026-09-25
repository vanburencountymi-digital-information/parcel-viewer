// Every layer toggle in the Layers pane turns on and off without errors.
const { test, expect, gotoViewer, waitForMapIdle } = require('./fixtures');

test('every layer toggle turns on and off cleanly', async ({ page, consoleGuard }) => {
  // Federal WMS overlays (FEMA, USFWS, NRCS, USGS) are third-party and occasionally slow or
  // down; a failed *tile* there is their outage, not our bug. Script errors still fail.
  consoleGuard.allow(/Failed to load resource/);
  await gotoViewer(page);
  const panel = page.locator('#map-control-panel');
  if (!(await panel.isVisible())) await page.locator('#mcp-reopen-tab').click();
  await page.locator('.mcp-tab[data-tab="layers"]').click();
  const toggles = page.locator('#mcp-pane-layers input[type="checkbox"]').filter({ visible: true });
  const n = await toggles.count();
  expect(n).toBeGreaterThan(10);
  for (let i = 0; i < n; i++) {
    const t = toggles.nth(i);
    const was = await t.isChecked();
    await t.click();
    await waitForMapIdle(page, 3000);
    expect(await t.isChecked()).toBe(!was);
    await t.click();
    expect(await t.isChecked()).toBe(was);
  }
});

test('aerial imagery replaces the street basemap and back', async ({ page }) => {
  await gotoViewer(page);
  if (!(await page.locator('#map-control-panel').isVisible())) await page.locator('#mcp-reopen-tab').click();
  await page.locator('.mcp-tab[data-tab="layers"]').click();
  const vis = () => page.evaluate(() => ['basemap', 'basemap-labels', 'mi-aerial'].map((id) => window.PS_MAP.getLayoutProperty(id, 'visibility') || 'visible'));
  await page.locator('#toggle-aerial').check();
  expect(await vis()).toEqual(['none', 'none', 'visible']);
  await page.locator('#toggle-aerial').uncheck();
  expect(await vis()).toEqual(['visible', 'visible', 'none']);
});
