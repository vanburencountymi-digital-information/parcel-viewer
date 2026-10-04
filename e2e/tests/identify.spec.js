// Clicking the map with a federal overlay on shows an identify popup. The proxy response
// is mocked so these test OUR rendering deterministically, independent of FEMA uptime.
const { test, expect, gotoViewer, waitForMapIdle } = require('./fixtures');

// The overlay's map tiles come straight from the federal WMS; their outages aren't ours.
const FEDERAL = /Failed to load resource.*\[https:\/\/(hazards\.fema\.gov|fwspublicservices|sdmdataaccess|elevation\.nationalmap)/;
const HOSTILE = '<img src=x onerror="window.__xss=1">';

function floodResponse(zone, subtype = '') {
  return JSON.stringify({ features: [{ attributes: { FLD_ZONE: zone, ZONE_SUBTY: subtype } }] });
}

async function setup(page, consoleGuard) {
  consoleGuard.allow(FEDERAL);
  await gotoViewer(page);
  await page.evaluate(() => window.PS_MAP.jumpTo({ center: [-85.905, 42.211], zoom: 15 }));
  await waitForMapIdle(page);
  if (!(await page.locator('#map-control-panel').isVisible())) await page.locator('#mcp-reopen-tab').click();
  await page.locator('.mcp-tab[data-tab="layers"]').click();
  await page.locator('#overlay-flood-toggle').check();
}

async function clickMap(page, dx = 150, dy = 0) {
  const box = await page.locator('canvas.maplibregl-canvas').boundingBox();
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
}

test('flood identify shows the zone, escapes upstream text, and closes', async ({ page, consoleGuard }) => {
  await page.route(/\/api\/wms-proxy\?url=https%3A%2F%2Fhazards\.fema\.gov/, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: floodResponse('AE', HOSTILE) }));
  await setup(page, consoleGuard);
  await clickMap(page);
  const popup = page.locator('.wfi-mgl-popup');
  await expect(popup).toBeVisible();
  await expect(popup).toContainText('Zone AE — Base flood elevation determined');
  await expect(popup.locator('img')).toHaveCount(0);                 // rendered as text, not markup
  await expect(popup).toContainText('<img src=x');
  expect(await page.evaluate(() => window.__xss || 0)).toBe(0);
  await popup.locator('.maplibregl-popup-close-button').click();
  await expect(popup).toHaveCount(0);
});

test('no flood feature at the point: no popup', async ({ page, consoleGuard }) => {
  await page.route(/\/api\/wms-proxy\?url=https%3A%2F%2Fhazards\.fema\.gov/, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ features: [] }) }));
  await setup(page, consoleGuard);
  await clickMap(page);
  await page.waitForTimeout(1500);
  await expect(page.locator('.wfi-mgl-popup')).toHaveCount(0);
});

test('rapid clicks: only the latest result is shown (a slow earlier lookup must not win)', async ({ page, consoleGuard }) => {
  let n = 0;
  await page.route(/\/api\/wms-proxy\?url=https%3A%2F%2Fhazards\.fema\.gov/, async (r) => {
    const mine = ++n;
    if (mine === 1) await new Promise((res) => setTimeout(res, 2500));   // first lookup is slow
    await r.fulfill({ status: 200, contentType: 'application/json', body: floodResponse(mine === 1 ? 'A' : 'AO') });   // (Zone X is suppressed by design)
  });
  await setup(page, consoleGuard);
  await clickMap(page, 150, 0);
  await page.waitForTimeout(200);
  await clickMap(page, 150, 80);
  await page.waitForTimeout(4000);                                        // both responses have landed
  const popups = page.locator('.wfi-mgl-popup');
  await expect(popups, 'exactly one popup').toHaveCount(1);
  await expect(popups).toContainText('Zone AO');
});

test('proxy failure: no popup, no uncaught errors', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/Failed to load resource.*wms-proxy/);
  await page.route(/\/api\/wms-proxy\?url=https%3A%2F%2Fhazards\.fema\.gov/, (r) =>
    r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream map service unavailable"}' }));
  await setup(page, consoleGuard);
  await clickMap(page);
  await page.waitForTimeout(1500);
  await expect(page.locator('.wfi-mgl-popup')).toHaveCount(0);
});
