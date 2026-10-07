// The map's right-click menu (DIC-1882): copy the coordinates of a point in several
// formats, select the parcel there, center, and open the spot in Google Maps / Street View.
const { test, expect, gotoViewer, selectParcelViaSearch, selectedParcelPoint, selectedPin, waitForSelectedInIndex, waitForMapIdle, ui } = require('./fixtures');

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

// The menu is named by its coordinate readout (changes per point), so find it by an item it always has.
const menu = (page) => page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Center the map here' }) });
// Each row's accessible name is its label followed by the text it shows (copy rows).
const ITEMS = {
  'copy-dd': /^Latitude, longitude/,
  'copy-dms': /^Degrees, minutes, seconds/,
  'copy-ddm': /^Degrees, decimal minutes/,
  'copy-spc': /^MI State Plane South/,
  'copy-lnglat': /^Longitude, latitude/,
  select: 'Select the parcel here',
  center: 'Center the map here',
  'google-maps': 'Open in Google Maps',
  'street-view': 'Street View here',
};
const item = (page, id) => menu(page).getByRole('menuitem', { name: ITEMS[id] });
const detail = async (page, id) => (await item(page, id).getByTestId('pv-ctx-detail').textContent()).trim();
const copyToast = (page) => page.getByRole('status').filter({ hasText: /^Copied / });

// A point on the map canvas, in page coordinates, away from the floating panels.
async function mapPoint(page, fx = 0.35, fy = 0.45) {
  const box = await ui.mapCanvas(page).boundingBox();
  return { x: Math.round(box.x + box.width * fx), y: Math.round(box.y + box.height * fy) };
}
async function rightClick(page, pt) {
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  await expect(menu(page)).toBeVisible();
}
const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());

test('right-click opens the menu at the pointer with every copy format and the actions', async ({ page }) => {
  await gotoViewer(page);
  const pt = await mapPoint(page);
  await rightClick(page, pt);
  // The box placed at the pointer (it also holds the readout header around the menu).
  const box = await page.getByTestId('pv-ctx-menu').boundingBox();
  expect(Math.abs(box.x - pt.x)).toBeLessThanOrEqual(2);
  const ids = await menu(page).getByRole('menuitem').evaluateAll((els) => els.map((e) => e.dataset.ctx));
  expect(ids.slice(0, 5)).toEqual(['copy-dd', 'copy-dms', 'copy-ddm', 'copy-spc', 'copy-lnglat']);
  expect(ids).toEqual(expect.arrayContaining(['center', 'google-maps', 'street-view']));
  // Focus moves into the menu, so the keyboard works straight away.
  await expect(item(page, 'copy-dd')).toBeFocused();
});

test('each copy row puts exactly its shown text on the clipboard', async ({ page }) => {
  await gotoViewer(page);
  const pt = await mapPoint(page);
  for (const id of ['copy-dd', 'copy-dms', 'copy-ddm', 'copy-spc', 'copy-lnglat']) {
    await rightClick(page, pt);
    const shown = await detail(page, id);
    await item(page, id).click();
    await expect(menu(page)).toHaveCount(0);
    expect(await clipboard(page), id).toBe(shown);
    await expect(copyToast(page)).toHaveText('Copied ' + shown);
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
  await item(page, 'copy-dd').click();
  const [lat, lng] = (await clipboard(page)).split(',').map(Number);
  expect(Math.abs(lat - expected.lat)).toBeLessThan(2e-6);
  expect(Math.abs(lng - expected.lng)).toBeLessThan(2e-6);
  // Van Buren County is in the NW quadrant; the GIS-order row is the same point reversed.
  expect(lat).toBeGreaterThan(41.9);
  expect(lng).toBeLessThan(-85.7);
  await rightClick(page, pt);
  const spc = await detail(page, 'copy-spc');
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
  await ui.parcelPanel(page).getByRole('button', { name: 'Clear selection' }).click();
  expect(await selectedPin(page)).toBeNull();
  await waitForMapIdle(page);
  const before = await page.evaluate(() => { const c = window.PS_MAP.getCenter(); return [c.lng, c.lat, window.PS_MAP.getZoom()]; });
  await rightClick(page, pt);
  await item(page, 'select').click();
  await expect(page.getByTestId('parcel-info-pin')).toHaveText(pin);
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
  await expect(menu(page)).toBeVisible();
  await expect(item(page, 'copy-dd')).toBeFocused();
  await page.waitForTimeout(600);
  await expect(menu(page), 'still open: the orbit stopped').toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(item(page, 'copy-dms')).toBeFocused();
  await page.keyboard.press('End');
  await expect(item(page, 'street-view')).toBeFocused();
  await page.keyboard.press('ArrowDown');   // wraps
  await expect(item(page, 'copy-dd')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(ui.mapCanvas(page)).toBeFocused();
  expect(await selectedPin(page)).not.toBeNull();
  // Enter on a row activates it.
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('Enter');
  await expect(menu(page)).toHaveCount(0);
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
  await expect(menu(page)).toHaveCount(0);

  await rightClick(page, pt);
  await page.evaluate(() => window.PS_MAP.panBy([60, 0], { duration: 0 }));
  await expect(menu(page)).toHaveCount(0);

  await rightClick(page, pt);
  await ui.searchInput(page).click();
  await expect(menu(page)).toHaveCount(0);
});

test('"Center the map here" and the Google Maps / Street View links use the clicked point', async ({ page }) => {
  await gotoViewer(page);
  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  const pt = await mapPoint(page);
  await rightClick(page, pt);
  const dd = await detail(page, 'copy-dd');
  const q = dd.replace(', ', ',');
  await item(page, 'google-maps').click();
  await rightClick(page, pt);
  await item(page, 'street-view').click();
  expect(await page.evaluate(() => window.__opened)).toEqual([
    'https://www.google.com/maps/search/?api=1&query=' + q,
    'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + q,
  ]);

  await rightClick(page, pt);
  await item(page, 'center').click();
  await waitForMapIdle(page);
  const c = await page.evaluate(() => { const x = window.PS_MAP.getCenter(); return x.lat.toFixed(6) + ', ' + x.lng.toFixed(6); });
  const [a, b] = c.split(', ').map(Number);
  const [ea, eb] = dd.split(', ').map(Number);
  expect(Math.abs(a - ea)).toBeLessThan(1e-5);
  expect(Math.abs(b - eb)).toBeLessThan(1e-5);
});
