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
  // E2E_MAP_BUDDY_API points the viewer at a Map Buddy on its own origin, as in production
  // (Cloud Run), instead of the dev stack's same-origin /map-buddy-api proxy, which the
  // production nginx doesn't have. Used to run the suite against infra/docker-compose.prod.yml.
  mapBuddyOverride: [async ({ page }, use) => {
    const url = process.env.E2E_MAP_BUDDY_API;
    if (url) await page.addInitScript((u) => { window.MAP_BUDDY_API = u; }, url);
    await use(url || null);
  }, { auto: true }],
  consoleGuard: [async ({ page }, use, testInfo) => {
    const problems = [];
    const allowed = [];
    page.on('console', (msg) => {
      // Include the resource URL (set for "Failed to load resource") so tests can allow a
      // specific third-party failure by URL without hiding our own.
      const where = (msg.location() && msg.location().url) || '';
      if (msg.type() === 'error') problems.push('console.error: ' + msg.text() + (where ? ' [' + where + ']' : ''));
    });
    page.on('pageerror', (err) => problems.push('uncaught: ' + err.message));
    // Browsers log a failed request as "Failed to load resource" without the URL; keep the
    // URL + status so a failure report says which request it was.
    const failed = [];
    page.on('response', (r) => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.request().method() + ' ' + r.url()); });
    await use({ allow: (re) => allowed.push(re), problems });
    const unexpected = problems.filter((p) => !allowed.concat(BENIGN).some((re) => re.test(p)));
    if (unexpected.length) {
      testInfo.annotations.push({ type: 'console', description: unexpected.join('\n') });
      throw new Error('Unexpected browser errors:\n  ' + unexpected.slice(0, 10).join('\n  ') +
        (failed.length ? '\nFailed requests:\n  ' + failed.slice(0, 10).join('\n  ') : ''));
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

// Locators for the parts of the page most specs use, by role, label or test id (DIC-2180):
// never by page structure, so the markup can change (ES modules, Vue) without the tests.
const ui = {
  searchInput: (page) => page.getByRole('combobox', { name: 'Search parcels by parcel number, owner, or address' }),
  searchResults: (page) => page.getByRole('listbox', { name: 'Parcel search results' }),
  parcelPanel: (page) => page.getByRole('region', { name: 'Parcel' }),
  mapControls: (page) => page.getByRole('complementary', { name: 'Map controls' }),
  mapCanvas: (page) => page.locator('canvas.maplibregl-canvas'),   // MapLibre's own markup
  helpMenuButton: (page) => page.getByRole('button', { name: 'Help and tools' }),
  helpMenu: (page) => page.getByRole('menu', { name: 'Help and tools' }),
  mapBuddyButton: (page) => page.getByRole('button', { name: 'Open MapBuddy A.I. panel' }),
  mapBuddyInput: (page) => page.getByRole('textbox', { name: 'Message MapBuddy A.I.' }),
};

/** Open the map controls panel (if collapsed) and the given tab: Layers, Selection/Drawing/Measurement Tools. */
async function openMapControlsTab(page, tabName) {
  if (!(await ui.mapControls(page).isVisible())) await page.getByRole('button', { name: 'Open map controls' }).click();
  const tab = page.getByRole('tab', { name: tabName });
  if (!(await tab.isVisible())) await page.getByRole('button', { name: 'Show advanced tools' }).click();
  await tab.click();
  return page.getByRole('tabpanel', { name: tabName });
}

/** Search for `query` through the real search box and pick result `index`. Returns the result's pin. */
async function selectParcelViaSearch(page, query = 'paw paw', index = 0) {
  const input = ui.searchInput(page);
  if (!(await input.isVisible())) await page.getByRole('button', { name: 'Search parcels', exact: true }).click();
  await input.fill(query);
  const rows = ui.searchResults(page).getByRole('option');
  await expect(rows.first()).toBeVisible();
  const pin = (await rows.nth(index).getByTestId('parcel-search-result-pin').innerText()).split('·')[0].trim();
  await rows.nth(index).click();
  await expect(ui.parcelPanel(page)).toBeVisible();
  await expect(page.getByTestId('parcel-info-pin')).toHaveText(pin);
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

// The window hooks the tests may read (DIC-2180): the seam between the suite and the app's
// internals. A refactor (ES modules, Vue) must keep every one, which test-hooks.spec.js
// checks; anything else the tests need goes through the page, by role, label or test id.
// Map state can't be read from the DOM, which is why most of these exist.
const VIEWER_HOOKS = {
  PS_MAP: 'the MapLibre map: camera, project/unproject, layers, idle events',
  PS_STATE: 'app state: the selected parcel, the active draw tool',
  PS_PARCEL_INDEX: 'the parcels in view (GeoJSON features), what selections are checked against',
  PS_selectParcelById: 'select a parcel by id without a click',
  PV_MAP_BUDDY: "Map Buddy's command runner (no model call)",
  PV_VISION: "map look capture (Map Buddy's eyes)",
  COUNTY: 'the county manifest in use',
  PV_ENDPOINTS: 'resolved service URLs',
  PS_ANNOTATION_STORE: 'drawn annotations',
  PS_MEASURE_TOOL: 'the measure tool',
  PS_OVERLAY_LAYERS: 'overlay availability (a tile error still counts as "loaded" in MapLibre)',
  PV_BOOKMARKS: 'saved views',
  PV_PREFS: 'stored preferences',
  PV_COORDS: 'coordinate formatting and parsing',
  PV_COMPARE: 'the compare tray',
  turf: 'Turf, for geometry in assertions',
  proj4: 'proj4, for State Plane reference values',
  maplibregl: 'MapLibre itself (its version, in the smoke test)',
};
// Set only in a particular state, so not checked on a normal load.
const CONDITIONAL_HOOKS = {
  PV_CONFIG_SOURCE: "'fallback' when the viewer runs on the baked county manifest",
};
const ADMIN_HOOKS = { PV_ADMIN: 'the admin console state (getState)' };

module.exports = { VIEWER_HOOKS, CONDITIONAL_HOOKS, ADMIN_HOOKS, ui, openMapControlsTab, test, expect, gotoViewer, selectParcelViaSearch, waitForMapIdle, selectedParcelPoint, selectedPin, waitForSelectedInIndex, mapBuddy, clickGate };
