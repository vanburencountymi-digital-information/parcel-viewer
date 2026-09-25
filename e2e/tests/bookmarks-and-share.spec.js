// Bookmarks persist on this device; a Share link reopens the same parcel and view.
const { test, expect, gotoViewer, selectParcelViaSearch, selectedPin } = require('./fixtures');

test('bookmark a parcel, reload, and reopen it from the bookmarks list', async ({ page }) => {
  await gotoViewer(page);
  const pin = await selectParcelViaSearch(page);
  const toggle = page.locator('#parcel-info-panel [data-bm-toggle]');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await page.waitForFunction(() => window.PS_MAP && window.PS_MAP.isStyleLoaded());
  await page.locator('#pv-admin-btn').click();
  await page.locator('#pv-admin-menu [data-tool="bookmark"]').click();
  const entry = page.locator('.pv-modal-backdrop').getByText(pin).first();
  await expect(entry).toBeVisible();
  await entry.click();
  await expect.poll(() => selectedPin(page)).toBe(pin);
});

test('un-bookmarking removes it', async ({ page }) => {
  await gotoViewer(page);
  await selectParcelViaSearch(page);
  const toggle = page.locator('#parcel-info-panel [data-bm-toggle]');
  await toggle.click();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.PV_BOOKMARKS.list().length)).toBe(0);
});

test('a Share link reopens the same parcel', async ({ page, context }) => {
  await gotoViewer(page);
  const pin = await selectParcelViaSearch(page);
  await page.locator('#pv-admin-btn').click();
  await page.locator('#pv-admin-menu [data-tool="share"]').click();
  const url = await page.locator('#pv-share-url').inputValue();
  expect(url, 'the link identifies the parcel').toMatch(/[?&]parcel=\d+/);
  const other = await context.newPage();
  await other.goto(url);
  await other.waitForFunction(() => window.PS_MAP && window.PS_MAP.isStyleLoaded());
  await expect.poll(() => selectedPin(other), { timeout: 15_000 }).toBe(pin);
  await expect(other.locator('#parcel-info-panel')).toBeVisible();
});

test('a Share link with no parcel reopens the same map view', async ({ page, context }) => {
  await gotoViewer(page);
  await page.evaluate(() => window.PS_MAP.jumpTo({ center: [-86.1234, 42.2345], zoom: 14.5 }));
  await page.locator('#pv-admin-btn').click();
  await page.locator('#pv-admin-menu [data-tool="share"]').click();
  const url = await page.locator('#pv-share-url').inputValue();
  expect(url).toMatch(/[?&]view=/);
  const other = await context.newPage();
  await other.goto(url);
  await other.waitForFunction(() => window.PS_MAP && window.PS_MAP.isStyleLoaded());
  const v = await other.evaluate(() => ({ c: window.PS_MAP.getCenter().toArray(), z: window.PS_MAP.getZoom() }));
  expect(v.c[0]).toBeCloseTo(-86.1234, 3);
  expect(v.c[1]).toBeCloseTo(42.2345, 3);
  expect(v.z).toBeCloseTo(14.5, 1);
});

test('a malformed share link is ignored safely', async ({ page }) => {
  await page.goto('/demo/?parcel=../../config&view=abc,1,x');
  await page.waitForFunction(() => window.PS_MAP && window.PS_MAP.isStyleLoaded());
  expect(await selectedPin(page)).toBeNull();
});
