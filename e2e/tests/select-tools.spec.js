// Select tools produce correct selections: attribute filter, buffer, box drag, and the
// selection's CSV export / navigation / clearing.
const fs = require('fs');
const { test, expect, gotoViewer, selectParcelViaSearch, waitForMapIdle, ui, openMapControlsTab } = require('./fixtures');

const selectTab = (page) => page.getByRole('tabpanel', { name: 'Selection Tools' });
const openSelectTab = (page) => openMapControlsTab(page, 'Selection Tools');
// "Add to Selection" / "Remove from Selection" exist in both the filter and buffer
// sub-panels; only the open one is in the accessibility tree, and visible is asserted too.
const actionBtn = (page, name) => selectTab(page).getByRole('button', { name, exact: true }).filter({ visible: true });

// How many parcels are selected: the "n of N" nav label when it shows, else 0/1.
async function selectedCount(page) {
  const lbl = page.getByTestId('parcel-nav-label');
  if (!(await lbl.isVisible())) return (await page.evaluate(() => !!(window.PS_STATE && window.PS_STATE.parcel))) ? 1 : 0;
  const m = (await lbl.innerText()).match(/of (\d+)/); return m ? Number(m[1]) : 0;
}

async function selectOver5Acres(page, acres = '5') {
  const tab = selectTab(page);
  if (!(await tab.getByLabel('Filter field').isVisible())) await tab.getByRole('button', { name: 'Filter', exact: true }).click();
  await tab.getByLabel('Filter field').selectOption('gis_acres');
  await tab.getByLabel('Filter operator').selectOption('gt');
  await tab.getByLabel('Filter value').fill(String(acres));
  await actionBtn(page, 'Add to Selection').click();
}

test.beforeEach(async ({ page }) => {
  await gotoViewer(page);
  await page.evaluate(() => window.PS_MAP.jumpTo({ center: [-85.905, 42.211], zoom: 15 }));
  await waitForMapIdle(page);
  await page.waitForFunction(() => (window.PS_PARCEL_INDEX || []).length > 20, null, { timeout: 15_000 });
});

test('attribute filter: match count equals the parcels that satisfy it, and Add selects them', async ({ page }) => {
  const tab = await openSelectTab(page);
  await tab.getByRole('button', { name: 'Filter', exact: true }).click();
  await tab.getByLabel('Filter field').selectOption('gis_acres');
  await tab.getByLabel('Filter operator').selectOption('gt');
  await tab.getByLabel('Filter value').fill('5');
  const expected = await page.evaluate(() => window.PS_PARCEL_INDEX.filter((f) => parseFloat(f.properties.gis_acres) > 5).length);
  expect(expected, 'fixture: some parcels over 5 acres in view').toBeGreaterThan(1);
  await expect(page.getByTestId('filter-match-count')).toContainText(String(expected));
  await actionBtn(page, 'Add to Selection').click();
  await expect.poll(() => selectedCount(page)).toBe(expected);
});

test('selection CSV has a header plus one row per selected parcel', async ({ page }) => {
  await openSelectTab(page);
  await selectOver5Acres(page);
  const n = await selectedCount(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), selectTab(page).getByRole('button', { name: /Download CSV/ }).click()]);
  const text = fs.readFileSync(await dl.path(), 'utf8').trim();
  const lines = text.split(/\r?\n/);
  expect(lines.length, 'header + one row per parcel').toBe(n + 1);
  expect(lines[0].toLowerCase()).toContain('pin');
  expect(dl.suggestedFilename()).toMatch(/\.csv$/);
});

test('selection CSV neutralises spreadsheet formulas and quotes awkward text', async ({ page }) => {
  // Plant hostile values the way bad upstream data would arrive: in the /parcels response.
  // (Editing the in-memory index raced the index refresh after the map moved, which
  // replaced the edited features and made this test flaky.)
  await page.route(/\/api\/parcels\?/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const f of body.features || []) {
      f.properties.owner_name = '=HYPERLINK("http://evil","x")';
      f.properties.prop_class = 'a,b\r\nc';
    }
    await route.fulfill({ response: res, json: body });
  });
  const refreshed = page.evaluate(() => new Promise((r) => document.addEventListener('ps:parcel-index-updated', r, { once: true })));
  // Pan past the index's 20% padding so it really refetches (through the route above).
  await page.evaluate(() => window.PS_MAP.panBy([window.PS_MAP.getCanvas().clientWidth * 0.6, 0], { duration: 0 }));
  await refreshed;
  await openSelectTab(page);
  await selectOver5Acres(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), selectTab(page).getByRole('button', { name: /Download CSV/ }).click()]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  expect(text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
  expect(text).toContain('"a,b\r\nc"');
  // An index refetch can still be in flight through the route when the page closes.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('multi-selection navigation: next/prev and arrow keys move through parcels', async ({ page }) => {
  await openSelectTab(page);
  await selectOver5Acres(page);
  const pin = () => page.getByTestId('parcel-info-pin').innerText();
  const first = await pin();
  await page.getByRole('button', { name: 'Next parcel' }).click();
  const second = await pin();
  expect(second).not.toBe(first);
  await expect(page.getByTestId('parcel-nav-label')).toContainText('2 of');
  await page.getByRole('button', { name: 'Previous parcel' }).click();
  expect(await pin()).toBe(first);
  await ui.parcelPanel(page).click({ position: { x: 5, y: 5 } });
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
  await actionBtn(page, 'Remove from Selection').click();
  await expect.poll(() => selectedCount(page)).toBe(1);
  expect(await page.evaluate(() => window.PS_STATE.parcel && window.PS_STATE.parcel.pin)).toBe(kept);
});

test('clear selection empties it', async ({ page }) => {
  await openSelectTab(page);
  await selectOver5Acres(page);
  await selectTab(page).getByRole('button', { name: /Clear Selection/ }).click();
  expect(await page.evaluate(() => window.PS_STATE.parcel)).toBeNull();
  await expect(ui.parcelPanel(page)).toBeHidden();
});

test('buffer: parcels within the distance of the selected parcel get selected', async ({ page }) => {
  await selectParcelViaSearch(page);
  const tab = await openSelectTab(page);
  await tab.getByRole('button', { name: 'Buffer', exact: true }).click();
  await tab.getByLabel('Buffer distance', { exact: true }).fill('300');
  await tab.getByLabel('Buffer distance units').selectOption('feet');
  await expect(page.getByTestId('buffer-match-count')).toContainText(/\d/, { timeout: 15_000 });
  const shown = parseInt((await page.getByTestId('buffer-match-count').innerText()).match(/\d+/)[0], 10);
  expect(shown).toBeGreaterThan(0);
  await actionBtn(page, 'Add to Selection').click();
  await expect.poll(() => selectedCount(page)).toBeGreaterThan(1);
});

test('box select: dragging a rectangle selects the parcels inside it', async ({ page }) => {
  const tab = await openSelectTab(page);
  await tab.getByRole('button', { name: 'Box', exact: true }).click();
  const box = await ui.mapCanvas(page).boundingBox();
  const cx = box.x + box.width / 2 + 100, cy = box.y + box.height / 2;
  await page.mouse.move(cx - 80, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 80, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => selectedCount(page), { timeout: 10_000 }).toBeGreaterThan(1);
});
