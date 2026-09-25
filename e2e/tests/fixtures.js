// Shared fixtures + helpers for the Parcel Viewer e2e suite.
//
// Every test gets a console guard: any console error or uncaught exception during the
// test fails it, unless the test declares it expected with allowConsole(/regex/). Silent
// breakage (a handler throwing, a failed fetch nobody surfaces) is exactly what these
// tests are for, so it's opt-out per test, never global.
const base = require('@playwright/test');

// The standalone viewer has no /ws live-update backend (Parcel Studio does); the viewer
// tries at most twice and gives up, and the browser always logs those attempts. That bound
// is asserted in smoke.spec.js, so the guard ignores these lines everywhere else.
const BENIGN = [/WebSocket connection to '.*\/ws' failed/];

const test = base.test.extend({
  consoleGuard: [async ({ page }, use, testInfo) => {
    const problems = [];
    const allowed = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push('console.error: ' + msg.text());
    });
    page.on('pageerror', (err) => problems.push('uncaught: ' + err.message));
    await use({ allow: (re) => allowed.push(re), problems });
    const unexpected = problems.filter((p) => !allowed.concat(BENIGN).some((re) => re.test(p)));
    if (unexpected.length) {
      testInfo.annotations.push({ type: 'console', description: unexpected.join('\n') });
      throw new Error('Unexpected browser errors:\n  ' + unexpected.slice(0, 10).join('\n  '));
    }
  }, { auto: true }],
});

const { expect } = base;

/** Open the viewer and wait until the map style has loaded. */
async function gotoViewer(page, path = '/demo/') {
  await page.goto(path);
  await page.waitForFunction(() => {
    const m = window.PS_MAP || null;
    return !!(m && m.isStyleLoaded && m.isStyleLoaded());
  }, null, { timeout: 30_000 });
}

/** Search for `query` through the real search box and pick result `index`. Returns the result's pin. */
async function selectParcelViaSearch(page, query = 'paw paw', index = 0) {
  const input = page.locator('#parcel-search-input');
  if (!(await input.isVisible())) await page.locator('#pv-search-btn').click();
  await input.fill(query);
  const rows = page.locator('#parcel-search-results .parcel-search-result');
  await expect(rows.first()).toBeVisible();
  const pin = (await rows.nth(index).locator('.parcel-search-result-pin').innerText()).split('·')[0].trim();
  await rows.nth(index).click();
  await expect(page.locator('#parcel-info-panel')).toBeVisible();
  await expect(page.locator('.parcel-info-pin')).toHaveText(pin);
  await waitForMapIdle(page);
  return pin;
}

/** Resolve after the map finishes moving/loading (or after `ms`, whichever first). */
async function waitForMapIdle(page, ms = 8000) {
  await page.evaluate((ms) => new Promise((resolve) => {
    const m = window.PS_MAP;
    if (!m || (m.loaded() && !m.isMoving())) return resolve();
    const t = setTimeout(resolve, ms);
    m.once('idle', () => { clearTimeout(t); resolve(); });
  }), ms);
}

/** Wait until the selected parcel is in the viewport index (it hydrates ~1-3s after the map settles). */
async function waitForSelectedInIndex(page) {
  await page.waitForFunction(() => {
    const sel = window.PS_STATE && window.PS_STATE.parcel;
    return !!sel && (window.PS_PARCEL_INDEX || []).some((f) => String((f.properties || {}).pin) === String(sel.pin));
  }, null, { timeout: 15_000 });
}

/** Screen point (page coordinates) of a point inside the currently selected parcel. */
async function selectedParcelPoint(page) {
  return page.evaluate(() => {
    const pin = window.PS_STATE && window.PS_STATE.parcel && window.PS_STATE.parcel.pin;
    const f = (window.PS_PARCEL_INDEX || []).find((x) => String((x.properties || {}).pin) === String(pin));
    if (!f || !window.turf) return null;
    const c = window.turf.pointOnFeature(f).geometry.coordinates;
    const p = window.PS_MAP.project(c);
    const r = window.PS_MAP.getCanvas().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  });
}

/** PIN of the currently selected parcel (null if none). */
function selectedPin(page) {
  return page.evaluate(() => (window.PS_STATE && window.PS_STATE.parcel && window.PS_STATE.parcel.pin) || null);
}

/** Run Map Buddy commands exactly as the chat does (no model call). Returns the result chips. */
function mapBuddy(page, commands) {
  return page.evaluate((cmds) => window.PV_MAP_BUDDY.runCommands(cmds), commands);
}

/** The map-click gate held by an active draw/measure tool (null = parcel clicks work). */
function clickGate(page) {
  return page.evaluate(() => (window.PS_STATE || {}).activeDrawTool || null);
}

module.exports = { test, expect, gotoViewer, selectParcelViaSearch, waitForMapIdle, selectedParcelPoint, selectedPin, waitForSelectedInIndex, mapBuddy, clickGate };
