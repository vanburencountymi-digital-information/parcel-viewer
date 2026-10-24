// Page load: the viewer boots cleanly with the expected services and nothing noisy.
const { test, expect, gotoViewer, waitForMapIdle, ui } = require('./fixtures');

test('viewer loads, map renders, and the console stays clean for 10s', async ({ page }) => {
  await gotoViewer(page);
  await expect(page).toHaveTitle(/Parcel Viewer/);
  await expect(ui.mapCanvas(page)).toBeVisible();
  // Idle page time is when background loops (reconnects, pollers) show up as console noise.
  await page.waitForTimeout(10_000);
});

test("the pages carry nginx's CSP, so the suite's violation check tests the real policy", async ({ request }) => {
  // DIC-2556: report-only until the testing window; either header name passes.
  for (const path of ['/demo/', '/admin/']) {
    const headers = (await request.get(path)).headers();
    const csp = headers['content-security-policy'] || headers['content-security-policy-report-only'];
    expect(csp, path).toContain("script-src 'self';");
    expect(csp, path).toContain('report-uri /api/csp-report');
  }
});

test('basemap is Esri Canvas (no CARTO watermark tiles)', async ({ page }) => {
  const hosts = new Set();
  page.on('request', (r) => { try { hosts.add(new URL(r.url()).host); } catch (_) {} });
  await gotoViewer(page);
  await waitForMapIdle(page);
  expect([...hosts].some((h) => h.endsWith('arcgisonline.com'))).toBe(true);
  expect([...hosts].some((h) => h.includes('cartocdn'))).toBe(false);
});

test('the pinned libraries load from the site, MapLibre with its worker in /assets/', async ({ page }) => {
  // Bundled from npm at the versions package.json pins (DIC-2180, DIC-2379), not a CDN.
  const pinned = require('../../package.json').devDependencies;
  await gotoViewer(page);
  const v = await page.evaluate(() => ({
    maplibre: window.maplibregl && window.maplibregl.getVersion(),
    worker: window.maplibregl && window.maplibregl.getWorkerUrl().replace(location.origin, ''),
    turf: typeof window.turf, proj4: typeof window.proj4,
  }));
  expect(v).toEqual({
    maplibre: pinned['maplibre-gl'], worker: expect.stringMatching(/^\/assets\/maplibre-gl-worker-[\w-]{8}\.js$/),
    turf: 'object', proj4: 'function',
  });
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
  if (process.env.E2E_MAP_BUDDY_API) expect(r.mapBuddy).toBe(process.env.E2E_MAP_BUDDY_API.replace(/\/+$/, ''));
  else if (/^(localhost|127\.0\.0\.1)$/.test(new URL(page.url()).hostname)) expect(r.mapBuddy).toBe('/map-buddy-api');
});

test('no WebSocket reconnect spam: at most 2 /ws attempts in 20s', async ({ page }) => {
  const attempts = [];
  page.on('websocket', (ws) => { if (ws.url().endsWith('/ws')) attempts.push(ws.url()); });
  await gotoViewer(page);
  await page.waitForTimeout(20_000);
  expect(attempts.length).toBeLessThanOrEqual(2);
});
