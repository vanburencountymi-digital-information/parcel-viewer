// Settings that change what the viewer displays: area units, coordinate format, default
// basemap. Each must apply immediately to what's on screen and survive a reload.
const { test, expect, gotoViewer, selectParcelViaSearch, waitForMapIdle } = require('./fixtures');

async function openSettings(page) {
  await page.locator('#pv-admin-btn').click();
  await page.locator('#pv-admin-menu [data-tool="settings"]').click();
  await expect(page.locator('#pv-set-area')).toBeVisible();
}
const closeModal = (page) => page.keyboard.press('Escape');
const areaText = (page) => page.locator('#parcel-info-panel').innerText().then((t) => (t.match(/Area\s*\n?\s*([^\n]+)/) || [])[1]);
const centerText = (page) => page.locator('#parcel-info-panel').innerText().then((t) => (t.match(/Center\s*\n?\s*([^\n]+)/) || [])[1]);

test.beforeEach(async ({ page }) => {
  await gotoViewer(page);
  await selectParcelViaSearch(page);
});

test('area units: switching to square feet updates the open panel and persists', async ({ page }) => {
  const acres = await areaText(page);
  expect(acres).toMatch(/ ac/);
  await openSettings(page);
  await page.locator('#pv-set-area').selectOption('sqft');
  await closeModal(page);
  const sqft = await areaText(page);
  expect(sqft).toMatch(/^[\d,]+ sq ft$/);
  // Same area, different units (43,560 sq ft per acre; the panel rounds acres to 0.01).
  const ac = parseFloat(acres), ft = Number(sqft.replace(/[^\d]/g, ''));
  expect(Math.abs(ft / 43560 - ac)).toBeLessThan(0.006);
  await gotoViewer(page);
  await selectParcelViaSearch(page);
  expect(await areaText(page)).toMatch(/sq ft$/);
});

test('coordinate format: the Settings choice re-renders the open panel\'s Center', async ({ page }) => {
  const dd = await centerText(page);
  expect(dd).toMatch(/°N/);
  await openSettings(page);
  await page.locator('#pv-set-coord').selectOption('spc');
  await closeModal(page);
  await expect.poll(() => centerText(page)).toMatch(/^N [\d,]+\s+E [\d,]+ ft$/);
  await openSettings(page);
  await page.locator('#pv-set-coord').selectOption('dms');
  await closeModal(page);
  await expect.poll(() => centerText(page)).toMatch(/°\d\d'\d\d"N/);
});

test('coordinate readout: DMS and State Plane agree with decimal degrees', async ({ page }) => {
  const r = await page.evaluate(() => {
    const out = {};
    for (const f of ['dd', 'dms', 'spc']) {
      window.PV_COORDS.setFormat(f);
      window.PS_MAP.fire('mousemove', { lngLat: { lng: -85.905, lat: 42.211 }, point: { x: 1, y: 1 } });
      out[f] = document.getElementById('pv-coords').textContent;
    }
    out.spcRef = window.proj4('+proj=longlat +datum=WGS84 +no_defs',
      '+proj=lcc +lat_0=41.5 +lon_0=-84.3666666666667 +lat_1=42.1 +lat_2=43.6667 +x_0=4000000 +y_0=0 +ellps=GRS80 +units=us-ft +no_defs',
      [-85.905, 42.211]);
    return out;
  });
  expect(r.dd).toBe('42.21100°N  85.90500°W');
  expect(r.dms).toBe('42°12\'40"N  85°54\'18"W');
  const [, n, e] = r.spc.match(/N ([\d,]+)\s+E ([\d,]+) ft/);
  expect(Number(n.replace(/,/g, ''))).toBe(Math.round(r.spcRef[1]));
  expect(Number(e.replace(/,/g, ''))).toBe(Math.round(r.spcRef[0]));
});

test('default basemap: aerial applies now and after a reload', async ({ page }) => {
  await openSettings(page);
  await page.locator('#pv-set-basemap').selectOption('aerial');
  await closeModal(page);
  await expect(page.locator('#toggle-aerial')).toBeChecked();
  await gotoViewer(page);
  await expect(page.locator('#toggle-aerial')).toBeChecked();
  // And back to light turns aerial off.
  await openSettings(page);
  await page.locator('#pv-set-basemap').selectOption('light');
  await closeModal(page);
  await expect(page.locator('#toggle-aerial')).not.toBeChecked();
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).not.toBe('dark');
});
