// Page load: the viewer boots cleanly with the expected services and nothing noisy.
const { test, expect, gotoViewer, waitForMapIdle } = require('./fixtures');

test('viewer loads, map renders, and the console stays clean for 10s', async ({ page }) => {
  await gotoViewer(page);
  await expect(page).toHaveTitle(/Parcel Viewer/);
  await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
  // Idle page time is when background loops (reconnects, pollers) show up as console noise.
  await page.waitForTimeout(10_000);
});

test('basemap is Esri Canvas (no CARTO watermark tiles)', async ({ page }) => {
  const hosts = new Set();
  page.on('request', (r) => { try { hosts.add(new URL(r.url()).host); } catch (_) {} });
  await gotoViewer(page);
  await waitForMapIdle(page);
  expect([...hosts].some((h) => h.endsWith('arcgisonline.com'))).toBe(true);
  expect([...hosts].some((h) => h.includes('cartocdn'))).toBe(false);
});

test('pinned CDN libraries load under SRI', async ({ page }) => {
  await gotoViewer(page);
  const v = await page.evaluate(() => ({
    maplibre: window.maplibregl && window.maplibregl.getVersion(),
    turf: typeof window.turf, proj4: typeof window.proj4,
  }));
  expect(v).toEqual({ maplibre: '4.7.1', turf: 'object', proj4: 'function' });
});

test('served config and Map Buddy endpoint resolve (local stack -> bundled container)', async ({ page }) => {
  await gotoViewer(page);
  const r = await page.evaluate(() => ({
    county: window.COUNTY && window.COUNTY.tenant,
    configSource: window.PV_CONFIG_SOURCE || 'api',
    mapBuddy: window.PV_ENDPOINTS && window.PV_ENDPOINTS.mapBuddyBase(),
  }));
  expect(r.county).toBe('vanburen');
  expect(r.configSource).toBe('api');
  if (/^(localhost|127\.0\.0\.1)$/.test(new URL(page.url()).hostname)) expect(r.mapBuddy).toBe('/map-buddy-api');
});

test('no WebSocket reconnect spam: at most 2 /ws attempts in 20s', async ({ page }) => {
  const attempts = [];
  page.on('websocket', (ws) => { if (ws.url().endsWith('/ws')) attempts.push(ws.url()); });
  await gotoViewer(page);
  await page.waitForTimeout(20_000);
  expect(attempts.length).toBeLessThanOrEqual(2);
});
