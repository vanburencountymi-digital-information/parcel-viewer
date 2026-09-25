// Every Map Buddy command that opens a window, tool or mode, driven exactly as the chat
// does (PV_MAP_BUDDY.runCommands; no model call). After each: whatever it opened closes
// via its own control or Esc, no tool is left holding the map-click gate, and a real
// click on a parcel still selects it. Regression guard for DIC-1875 (a dimension popup
// that couldn't close; a draw mode that froze the map).
const { test, expect, gotoViewer, selectParcelViaSearch, selectedPin, selectedParcelPoint,
  waitForSelectedInIndex, mapBuddy, clickGate } = require('./fixtures');

const SURFACES = '#msr-hud, #drw-hud, .pv-modal-backdrop, .pv-compare-overlay, .pv-profile-overlay';

/** Close every visible surface via its own close control (or Esc). Returns what closed how. */
async function closeAll(page) {
  const log = [];
  for (let round = 0; round < 4; round++) {
    const open = page.locator(SURFACES).filter({ visible: true });
    if (await open.count() === 0) break;
    const el = open.first();
    const btn = el.locator('.msr-hud-close, [data-close], .pv-modal-close, [aria-label*="lose" i]').filter({ visible: true }).first();
    if (await btn.count()) await btn.click(); else await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    log.push(await el.isVisible() ? 'still open' : 'closed');
  }
  return log;
}

async function assertMapStillSelectsParcels(page, pin) {
  expect(await clickGate(page), 'no tool left holding the click gate').toBeNull();
  // Deselect, then click the parcel on the canvas: it must select again.
  if (await page.locator('#parcel-info-panel').isVisible()) await page.locator('#parcel-info-panel .parcel-info-close').click();
  await page.evaluate((pin) => window.PS_MAP.jumpTo({ center: window.turf.pointOnFeature(
    window.PS_PARCEL_INDEX.find((f) => String(f.properties.pin) === pin)).geometry.coordinates }), pin);
  const pt = await page.evaluate((pin) => {
    const f = window.PS_PARCEL_INDEX.find((x) => String(x.properties.pin) === pin);
    const p = window.PS_MAP.project(window.turf.pointOnFeature(f).geometry.coordinates);
    const r = window.PS_MAP.getCanvas().getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y };
  }, pin);
  await page.mouse.click(pt.x, pt.y);
  await expect.poll(() => selectedPin(page), { message: 'map click selects the parcel' }).toBe(pin);
}

const CASES = [
  ['dimension_parcel', (pin) => ({ pin })],
  ['activate_draw_tool (point)', () => ({ tool: 'point' }), 'activate_draw_tool'],
  ['activate_draw_tool (polygon)', () => ({ tool: 'polygon' }), 'activate_draw_tool'],
  ['draw_parcel_buffer', (pin) => ({ pin, distance_ft: 100 })],
  ['place_structure_in_parcel', (pin) => ({ pin, width_ft: 40, depth_ft: 30 })],
  ['set_parcel_labels', () => ({ field: 'owner' })],
  ['describe_neighborhood', (pin) => ({ pin, distance_ft: 1320 })],
  ['open_tool (packet)', () => ({ tool: 'packet' }), 'open_tool'],
  ['open_tool (tax)', () => ({ tool: 'tax' }), 'open_tool'],
  ['open_tool (assess)', () => ({ tool: 'assess' }), 'open_tool'],
  ['open_tool (settings)', () => ({ tool: 'settings' }), 'open_tool'],
  ['open_panel (measure)', () => ({ tab: 'measure' }), 'open_panel'],
  ['clear_annotations', () => ({})],
];

test.describe('Map Buddy commands leave the map usable', () => {
  let pin;
  test.beforeEach(async ({ page, consoleGuard }) => {
    // Some commands (describe_neighborhood, flood layers) query FEMA / USFWS / NRCS
    // through /api/wms-proxy; an upstream 502 there is their outage, not ours.
    consoleGuard.allow(/Failed to load resource.*\/api\/wms-proxy\?url=https%3A%2F%2F(hazards\.fema\.gov|fwspublicservices|sdmdataaccess)/);
    await gotoViewer(page);
    pin = await selectParcelViaSearch(page);
    await waitForSelectedInIndex(page);
  });

  for (const [name, payloadFor, type] of CASES) {
    test(name, async ({ page }) => {
      const chips = await mapBuddy(page, [{ type: type || name, payload: payloadFor(pin) }]);
      expect(chips.filter(Boolean).length, 'command produced a result chip').toBeGreaterThan(0);
      await page.waitForTimeout(/describe|packet|tax|assess/.test(name) ? 2500 : 800);
      // A draw mode is exited with Esc (nothing on screen to "close").
      if (/draw_tool/.test(name)) await page.keyboard.press('Escape');
      const log = await closeAll(page);
      expect(log, 'every surface closed').not.toContain('still open');
      await assertMapStillSelectsParcels(page, pin);
    });
  }

  test('compare_parcels opens with 2 parcels and closes', async ({ page }) => {
    const pins = await page.evaluate(() => window.PS_PARCEL_INDEX.slice(0, 2).map((f) => f.properties.pin));
    await mapBuddy(page, [{ type: 'compare_parcels', payload: { pins } }]);
    const overlay = page.locator('.pv-compare-overlay');
    await expect(overlay).toBeVisible();
    expect(await closeAll(page)).not.toContain('still open');
    await expect(overlay).toBeHidden();
  });
});
