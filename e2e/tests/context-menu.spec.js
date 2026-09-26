// The map's right-click menu (DIC-1882): copy the coordinates of a point in several
// formats, select the parcel there, center, and open the spot in Google Maps / Street View.
const { test, expect, gotoViewer, selectParcelViaSearch, selectedParcelPoint, selectedPin, waitForSelectedInIndex, waitForMapIdle } = require('./fixtures');

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const MENU = '#pv-ctx-menu';

// A point on the map canvas, in page coordinates, away from the floating panels.
async function mapPoint(page, fx = 0.35, fy = 0.45) {
  const box = await page.locator('#map canvas.maplibregl-canvas').boundingBox();
  return { x: Math.round(box.x + box.width * fx), y: Math.round(box.y + box.height * fy) };
}
async function rightClick(page, pt) {
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  await expect(page.locator(MENU)).toBeVisible();
}
const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());

test('right-click opens the menu at the pointer with every copy format and the actions', async ({ page }) => {
  await gotoViewer(page);
  const pt = await mapPoint(page);
  await rightClick(page, pt);
  const box = await page.locator(MENU).boundingBox();
  expect(Math.abs(box.x - pt.x)).toBeLessThanOrEqual(2);
  const ids = await page.locator(`${MENU} [role="menuitem"]`).evaluateAll((els) => els.map((e) => e.dataset.ctx));
  expect(ids.slice(0, 5)).toEqual(['copy-dd', 'copy-dms', 'copy-ddm', 'copy-spc', 'copy-lnglat']);
  expect(ids).toEqual(expect.arrayContaining(['center', 'google-maps', 'street-view']));
  // Focus moves into the menu, so the keyboard works straight away.
  await expect(page.locator(`${MENU} [data-ctx="copy-dd"]`)).toBeFocused();
});

test('each copy row puts exactly its shown text on the clipboard', async ({ page }) => {
  await gotoViewer(page);
  const pt = await mapPoint(page);
  for (const id of ['copy-dd', 'copy-dms', 'copy-ddm', 'copy-spc', 'copy-lnglat']) {
    await rightClick(page, pt);
    const row = page.locator(`${MENU} [data-ctx="${id}"]`);
    const shown = (await row.locator('.pv-ctx-detail').textContent()).trim();
    await row.click();
    await expect(page.locator(MENU)).toHaveCount(0);
    expect(await clipboard(page), id).toBe(shown);
    await expect(page.locator('.pv-ctx-toast')).toHaveText('Copied ' + shown);
  }
});

test('the copied coordinates are the clicked point', async ({ page }) => {
  await gotoViewer(page);
  const pt = await mapPoint(page, 0.4, 0.5);
  const expected = await page.evaluate(({ x, y }) => {
    const r = window.PS_MAP.getCanvas().getBoundingClientRect();
    const ll = window.PS_MAP.unproject([x - r.left, y - r.top]);
    return { lng: ll.lng, lat: ll.lat };
  }, pt);
  await rightClick(page, pt);
  await page.locator(`${MENU} [data-ctx="copy-dd"]`).click();
  const [lat, lng] = (await clipboard(page)).split(',').map(Number);
  expect(Math.abs(lat - expected.lat)).toBeLessThan(2e-6);
  expect(Math.abs(lng - expected.lng)).toBeLessThan(2e-6);
  // Van Buren County is in the NW quadrant; the GIS-order row is the same point reversed.
  expect(lat).toBeGreaterThan(41.9);
  expect(lng).toBeLessThan(-85.7);
  await rightClick(page, pt);
  const spc = (await page.locator(`${MENU} [data-ctx="copy-spc"] .pv-ctx-detail`).textContent()).trim();
  const m = spc.match(/^N (\d+), E (\d+)$/);
  expect(m, spc).not.toBeNull();
  // Michigan South State Plane, US ft: the county sits ~200–400k ft north, ~12.5–12.8M ft east.
  expect(Number(m[1])).toBeGreaterThan(150000);
  expect(Number(m[1])).toBeLessThan(450000);
  expect(Number(m[2])).toBeGreaterThan(12400000);
  expect(Number(m[2])).toBeLessThan(12900000);
});

test('"Select the parcel here" selects the parcel under the pointer without moving the map', async ({ page }) => {
  await gotoViewer(page);
  const pin = await selectParcelViaSearch(page);
  await waitForSelectedInIndex(page);
  const pt = await selectedParcelPoint(page);
  await page.locator('#parcel-info-panel .parcel-info-close').click();
  expect(await selectedPin(page)).toBeNull();
  await waitForMapIdle(page);
  const before = await page.evaluate(() => { const c = window.PS_MAP.getCenter(); return [c.lng, c.lat, window.PS_MAP.getZoom()]; });
  await rightClick(page, pt);
  await page.locator(`${MENU} [data-ctx="select"]`).click();
  await expect(page.locator('.parcel-info-pin')).toHaveText(pin);
  const after = await page.evaluate(() => { const c = window.PS_MAP.getCenter(); return [c.lng, c.lat, window.PS_MAP.getZoom()]; });
  expect(after).toEqual(before);
});

test('keyboard: Shift+F10 on the map opens it; arrows move; Escape closes without clearing the selection', async ({ page }) => {
  await gotoViewer(page);
  await selectParcelViaSearch(page);
  // No wait: the search arrival is still orbiting. Opening the menu must stop it, or the
  // map move would close the menu at once (failed that way before PS_cancelCinematic).
  await page.evaluate(() => window.PS_MAP.getCanvas().focus());
  await page.keyboard.press('Shift+F10');
  await expect(page.locator(MENU)).toBeVisible();
  await expect(page.locator(`${MENU} [data-ctx="copy-dd"]`)).toBeFocused();
  await page.waitForTimeout(600);
  await expect(page.locator(MENU), 'still open: the orbit stopped').toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(`${MENU} [data-ctx="copy-dms"]`)).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator(`${MENU} [data-ctx="street-view"]`)).toBeFocused();
  await page.keyboard.press('ArrowDown');   // wraps
  await expect(page.locator(`${MENU} [data-ctx="copy-dd"]`)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator(MENU)).toHaveCount(0);
  await expect(page.locator('#map canvas.maplibregl-canvas')).toBeFocused();
  expect(await selectedPin(page)).not.toBeNull();
  // Enter on a row activates it.
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('Enter');
  await expect(page.locator(MENU)).toHaveCount(0);
  expect(await clipboard(page)).toMatch(/^-?\d+\.\d{6}, -?\d+\.\d{6}$/);
});

test('a right-drag (rotate) does not open it; a map move or an outside click closes it', async ({ page }) => {
  await gotoViewer(page);
  const pt = await mapPoint(page);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(pt.x + 80, pt.y + 10, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(300);
  await expect(page.locator(MENU)).toHaveCount(0);

  await rightClick(page, pt);
  await page.evaluate(() => window.PS_MAP.panBy([60, 0], { duration: 0 }));
  await expect(page.locator(MENU)).toHaveCount(0);

  await rightClick(page, pt);
  await page.locator('#parcel-search').click();
  await expect(page.locator(MENU)).toHaveCount(0);
});

test('"Center the map here" and the Google Maps / Street View links use the clicked point', async ({ page }) => {
  await gotoViewer(page);
  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  const pt = await mapPoint(page);
  await rightClick(page, pt);
  const dd = (await page.locator(`${MENU} [data-ctx="copy-dd"] .pv-ctx-detail`).textContent()).trim();
  const q = dd.replace(', ', ',');
  await page.locator(`${MENU} [data-ctx="google-maps"]`).click();
  await rightClick(page, pt);
  await page.locator(`${MENU} [data-ctx="street-view"]`).click();
  expect(await page.evaluate(() => window.__opened)).toEqual([
    'https://www.google.com/maps/search/?api=1&query=' + q,
    'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + q,
  ]);

  await rightClick(page, pt);
  await page.locator(`${MENU} [data-ctx="center"]`).click();
  await waitForMapIdle(page);
  const c = await page.evaluate(() => { const x = window.PS_MAP.getCenter(); return x.lat.toFixed(6) + ', ' + x.lng.toFixed(6); });
  const [a, b] = c.split(', ').map(Number);
  const [ea, eb] = dd.split(', ').map(Number);
  expect(Math.abs(a - ea)).toBeLessThan(1e-5);
  expect(Math.abs(b - eb)).toBeLessThan(1e-5);
});
