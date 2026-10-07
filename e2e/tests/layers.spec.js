// Every layer toggle in the Layers pane turns on and off without errors.
const { test, expect, gotoViewer, waitForMapIdle, openMapControlsTab } = require('./fixtures');

test('every layer toggle turns on and off cleanly', async ({ page, consoleGuard }) => {
  // Federal WMS overlays (FEMA, USFWS, NRCS, USGS) are third-party and occasionally slow or
  // down; a failed *tile* there is their outage, not our bug. Script errors still fail.
  consoleGuard.allow(/Failed to load resource/);
  await gotoViewer(page);
  const pane = await openMapControlsTab(page, 'Layers');
  const toggles = pane.getByRole('checkbox').filter({ visible: true });
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
  const pane = await openMapControlsTab(page, 'Layers');
  const aerial = pane.getByRole('checkbox', { name: 'Aerial Imagery', exact: true });
  const vis = () => page.evaluate(() => ['basemap', 'basemap-labels', 'mi-aerial'].map((id) => window.PS_MAP.getLayoutProperty(id, 'visibility') || 'visible'));
  await aerial.check();
  expect(await vis()).toEqual(['none', 'none', 'visible']);
  await aerial.uncheck();
  expect(await vis()).toEqual(['visible', 'visible', 'none']);
});
