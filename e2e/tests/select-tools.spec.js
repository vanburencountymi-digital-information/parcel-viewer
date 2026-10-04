// Select tools produce correct selections: attribute filter, buffer, box drag, and the
// selection's CSV export / navigation / clearing.
const fs = require('fs');
const { test, expect, gotoViewer, selectParcelViaSearch, waitForMapIdle } = require('./fixtures');

async function openSelectTab(page) {
  if (!(await page.locator('#map-control-panel').isVisible())) await page.locator('#mcp-reopen-tab').click();
  const tab = page.locator('.mcp-tab[data-tab="select"]');
  if (!(await tab.isVisible())) await page.locator('#mcp-advanced-toggle').click();
  await tab.click();
}

const selectedCount = (page) => page.evaluate(() => {
  const lbl = document.getElementById('parcel-nav-label');
  const nav = document.getElementById('parcel-info-nav');
  if (!nav || nav.hidden) return (window.PS_STATE && window.PS_STATE.parcel) ? 1 : 0;
  const m = lbl.textContent.match(/of (\d+)/); return m ? Number(m[1]) : 0;
});

async function selectOver5Acres(page, acres = '5') {
  if (!(await page.locator('#filter-field').isVisible())) await page.locator('#tool-filter').click();
  await page.locator('#filter-field').selectOption('gis_acres');
  await page.locator('#filter-op').selectOption('gt');
  await page.locator('#filter-value').fill(String(acres));
  await page.locator('#filter-add-btn').click();
}

test.beforeEach(async ({ page }) => {
  await gotoViewer(page);
  await page.evaluate(() => window.PS_MAP.jumpTo({ center: [-85.905, 42.211], zoom: 15 }));
  await waitForMapIdle(page);
  await page.waitForFunction(() => (window.PS_PARCEL_INDEX || []).length > 20, null, { timeout: 15_000 });
});

test('attribute filter: match count equals the parcels that satisfy it, and Add selects them', async ({ page }) => {
  await openSelectTab(page);
  await page.locator('#tool-filter').click();
  await page.locator('#filter-field').selectOption('gis_acres');
  await page.locator('#filter-op').selectOption('gt');
  await page.locator('#filter-value').fill('5');
  const expected = await page.evaluate(() => window.PS_PARCEL_INDEX.filter((f) => parseFloat(f.properties.gis_acres) > 5).length);
  expect(expected, 'fixture: some parcels over 5 acres in view').toBeGreaterThan(1);
  await expect(page.locator('#filter-match-count')).toContainText(String(expected));
  await page.locator('#filter-add-btn').click();
  await expect.poll(() => selectedCount(page)).toBe(expected);
});

test('selection CSV has a header plus one row per selected parcel', async ({ page }) => {
  await openSelectTab(page);
  await selectOver5Acres(page);
  const n = await selectedCount(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#download-csv-btn').click()]);
  const text = fs.readFileSync(await dl.path(), 'utf8').trim();
  const lines = text.split(/\r?\n/);
  expect(lines.length, 'header + one row per parcel').toBe(n + 1);
  expect(lines[0].toLowerCase()).toContain('pin');
  expect(dl.suggestedFilename()).toMatch(/\.csv$/);
});

test('selection CSV neutralises spreadsheet formulas and quotes awkward text', async ({ page }) => {
  await openSelectTab(page);
  await selectOver5Acres(page);
  // Plant hostile values in the first selected parcel's attributes (as bad upstream data would).
  const pin = await page.evaluate(() => window.PS_STATE.parcel.pin);
  await page.evaluate((p) => {
    const f = window.PS_PARCEL_INDEX.find((x) => x.properties.pin === p);
    f.properties.owner_name = '=HYPERLINK("http://evil","x")';
    f.properties.prop_class = 'a,b\r\nc';
  }, pin);
  // Re-add so the selection holds the edited props.
  await page.locator('#clear-selection-btn').click();
  await selectOver5Acres(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#download-csv-btn').click()]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  expect(text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
  expect(text).toContain('"a,b\r\nc"');
});

test('multi-selection navigation: next/prev and arrow keys move through parcels', async ({ page }) => {
  await openSelectTab(page);
  await selectOver5Acres(page);
  const pin = () => page.locator('.parcel-info-pin').innerText();
  const first = await pin();
  await page.locator('#parcel-nav-next').click();
  const second = await pin();
  expect(second).not.toBe(first);
  await expect(page.locator('#parcel-nav-label')).toContainText('2 of');
  await page.locator('#parcel-nav-prev').click();
  expect(await pin()).toBe(first);
  await page.locator('#parcel-info-panel').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ArrowRight');
  expect(await pin()).toBe(second);
});

test('Remove from Selection drops the filter matches, keeping the rest', async ({ page }) => {
  await selectParcelViaSearch(page);           // this parcel must survive the removal
  const kept = await page.evaluate(() => window.PS_STATE.parcel.pin);
  const keptAcres = await page.evaluate((pin) => {
    const f = window.PS_PARCEL_INDEX.find((x) => x.properties.pin === pin);
    return f ? parseFloat(f.properties.gis_acres) : null;
  }, kept);
  expect(keptAcres, 'searched parcel is in the viewport index').not.toBeNull();
  await openSelectTab(page);
  await selectOver5Acres(page, keptAcres);     // strictly larger parcels: excludes the kept one
  const before = await selectedCount(page);
  expect(before).toBeGreaterThan(2);
  await page.locator('#filter-replace-btn').click();
  await expect.poll(() => selectedCount(page)).toBe(1);
  expect(await page.evaluate(() => window.PS_STATE.parcel && window.PS_STATE.parcel.pin)).toBe(kept);
});

test('clear selection empties it', async ({ page }) => {
  await openSelectTab(page);
  await selectOver5Acres(page);
  await page.locator('#clear-selection-btn').click();
  expect(await page.evaluate(() => window.PS_STATE.parcel)).toBeNull();
  await expect(page.locator('#parcel-info-panel')).toBeHidden();
});

test('buffer: parcels within the distance of the selected parcel get selected', async ({ page }) => {
  await selectParcelViaSearch(page);
  await openSelectTab(page);
  await page.locator('#tool-buffer').click();
  await page.locator('#buffer-distance').fill('300');
  await page.locator('#buffer-units').selectOption('feet');
  await expect(page.locator('#buffer-match-count')).toContainText(/\d/, { timeout: 15_000 });
  const shown = parseInt((await page.locator('#buffer-match-count').innerText()).match(/\d+/)[0], 10);
  expect(shown).toBeGreaterThan(0);
  await page.locator('#buffer-apply-btn').click();
  await expect.poll(() => selectedCount(page)).toBeGreaterThan(1);
});

test('box select: dragging a rectangle selects the parcels inside it', async ({ page }) => {
  await openSelectTab(page);
  await page.locator('#tool-box-select').click();
  const box = await page.locator('canvas.maplibregl-canvas').boundingBox();
  const cx = box.x + box.width / 2 + 100, cy = box.y + box.height / 2;
  await page.mouse.move(cx - 80, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 80, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => selectedCount(page), { timeout: 10_000 }).toBeGreaterThan(1);
});
