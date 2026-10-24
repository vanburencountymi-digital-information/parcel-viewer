// Measurement results are right, and drawings behave (create, undo, redo, clear).
// Shapes are drawn with real mouse clicks on the map canvas.
const { test, expect, gotoViewer, waitForMapIdle, clickGate, ui, openMapControlsTab } = require('./fixtures');

// Drawings on the map, through MapLibre's public GeoJSONSource.getData(); its private
// _data changed shape in 6.x (DIC-2379). null if the source is missing, never a silent 0.
const annotationCount = (page) => page.evaluate(async () => {
  const src = window.PS_MAP.getSource('annotation-source');
  const data = src && (await src.getData());
  return data && data.features ? data.features.length : null;
});

const measureTab = (page) => page.getByRole('tabpanel', { name: 'Measurement Tools' });
const drawTab = (page) => page.getByRole('tabpanel', { name: 'Drawing Tools' });
const hud = (page) => page.getByTestId('msr-hud');
/** The value cell of the measurement HUD row labelled `label`. */
const hudValue = (page, label) => hud(page).getByRole('row').filter({ hasText: label }).first().getByRole('cell').last();

/** Screen points of a square `size` px wide centred in the map, plus their lng/lat. */
async function squareOnMap(page, size = 200) {
  return page.evaluate((size) => {
    const m = window.PS_MAP, r = m.getCanvas().getBoundingClientRect();
    const cx = r.width / 2 + 120, cy = r.height / 2, h = size / 2;   // right of centre, clear of panels
    const px = [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];
    return px.map(([x, y]) => ({ x: r.left + x, y: r.top + y, lngLat: m.unproject([x, y]).toArray() }));
  }, size);
}

/** Record every annotation added to the store during the test. */
async function captureAnnotations(page) {
  await page.evaluate(() => {
    window.__added = [];
    const S = window.PS_ANNOTATION_STORE, orig = S.addAnnotation;
    S.addAnnotation = function (f) { window.__added.push(JSON.parse(JSON.stringify(f))); return orig.apply(this, arguments); };
  });
}

const num = (s) => parseFloat(String(s).replace(/,/g, ''));

test.describe('Measure', () => {
  test.beforeEach(async ({ page }) => {
    await gotoViewer(page);
    await page.evaluate(() => { window.PS_MAP.jumpTo({ center: [-86.0, 42.22], zoom: 16 }); });
    await waitForMapIdle(page);
    await captureAnnotations(page);
    await openMapControlsTab(page, 'Measurement Tools');
  });

  test('area: the reported area matches the drawn shape', async ({ page }) => {
    await measureTab(page).getByRole('button', { name: 'Measure Area' }).click();
    const pts = await squareOnMap(page);
    for (const p of pts) await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Enter');
    await expect(hud(page)).toBeVisible();
    const shown = num((await hudValue(page, 'Area').innerText()).match(/([\d,]+) sq ft/)[1]);
    const r = await page.evaluate((clicked) => {
      const saved = window.__added.find((f) => f.properties.featureType === 'measure-area');
      const SQFT = 0.09290304;
      const ring = clicked.concat([clicked[0]]);
      return {
        savedSqft: turf.area(saved) / SQFT,
        clickedSqft: turf.area(turf.polygon([ring])) / SQFT,
      };
    }, pts.map((p) => p.lngLat));
    expect(Math.abs(shown - r.savedSqft) / r.savedSqft, 'shown area = area of the saved shape').toBeLessThan(0.001);
    expect(Math.abs(shown - r.clickedSqft) / r.clickedSqft, 'area ≈ the clicked square (snapping tolerance)').toBeLessThan(0.05);
  });

  test('coordinates: every Copy button copies the whole coordinate (DMS included)', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await measureTab(page).getByRole('button', { name: 'Coordinates' }).click();
    const box = await ui.mapCanvas(page).boundingBox();
    await page.mouse.click(box.x + box.width / 2 + 120, box.y + box.height / 2);
    const copies = hud(page).getByRole('button', { name: 'Copy', exact: true });
    await expect(copies.first()).toBeVisible();
    // DMS used to lose everything after the seconds of latitude: its " ended the
    // data-copy attribute early (CodeQL js/identity-replacement led to it, DIC-1880).
    const dms = copies.nth(1);
    const attr = await dms.getAttribute('data-copy');
    expect(attr).toMatch(/^\d+° \d+' [\d.]+" N, \d+° \d+' [\d.]+" W$/);
    await dms.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(attr);
  });

  test('distance: the reported total matches the clicked path', async ({ page }) => {
    await measureTab(page).getByRole('button', { name: 'Measure Dist.' }).click();
    const pts = (await squareOnMap(page)).slice(0, 3);
    for (const p of pts) await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Enter');
    const cell = hudValue(page, 'Total Distance');
    await expect(cell).toBeVisible();
    const text = await cell.innerText();
    const shownFt = /mi/.test(text) ? num(text) * 5280 : num(text);
    const expectedFt = await page.evaluate((c) => turf.distance(c[0], c[1], { units: 'feet' }) + turf.distance(c[1], c[2], { units: 'feet' }), pts.map((p) => p.lngLat));
    expect(Math.abs(shownFt - expectedFt) / expectedFt).toBeLessThan(0.05);
  });

  test('Clear This Measurement removes it and Esc releases the map', async ({ page }) => {
    await measureTab(page).getByRole('button', { name: 'Measure Area' }).click();
    for (const p of await squareOnMap(page)) await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Enter');
    await hud(page).getByRole('button', { name: 'Clear This Measurement' }).click();
    await page.keyboard.press('Escape');
    expect(await clickGate(page)).toBeNull();
  });

  test('a tool button turns its tool on, and pressing it again turns it off', async ({ page }) => {
    const active = () => page.evaluate(() => window.PS_MEASURE_TOOL.getActiveTool());
    await measureTab(page).getByRole('button', { name: 'Measure Area' }).click();
    expect(await active()).toBe('measure-area');
    await measureTab(page).getByRole('button', { name: 'Coordinates' }).click();
    expect(await active()).toBe('coordinates');
    await measureTab(page).getByRole('button', { name: 'Coordinates' }).click();
    expect(await active()).toBe(null);
  });

  test('settings: Miles shows distances in miles; the choices persist across a reload', async ({ page }) => {
    const tab = measureTab(page);
    await tab.getByRole('button', { name: 'Miles', exact: true }).click();
    await tab.getByRole('button', { name: 'Azimuth', exact: true }).click();
    await tab.getByLabel('Bearing').check();
    await tab.getByRole('button', { name: 'Measure Dist.' }).click();
    for (const p of (await squareOnMap(page)).slice(0, 2)) await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Enter');
    await expect(hudValue(page, 'Total Distance')).toHaveText(/^[\d.]+ mi \([\d,.]+ ft\)$/);
    const stored = () => page.evaluate(() => [localStorage.getItem('ps_measureUnits'), localStorage.getItem('ps_bearingFormat'),
      JSON.parse(localStorage.getItem('ps_measureAnnotate'))]);
    expect(await stored()).toEqual(['miles', 'azimuth', { distance: true, bearing: true }]);
    await gotoViewer(page);
    await openMapControlsTab(page, 'Measurement Tools');
    await expect(measureTab(page).getByLabel('Bearing')).toBeChecked();
    await expect(measureTab(page).getByLabel('Distance')).toBeChecked();
  });

  test('Advanced Tools opens the advanced tools, and stays open after a reload', async ({ page }) => {
    const tab = measureTab(page);
    await expect(tab.getByRole('button', { name: 'Bearing & Dist.' })).toBeHidden();
    await tab.getByRole('button', { name: /Advanced Tools/ }).click();
    await expect(tab.getByRole('button', { name: /▼ Advanced Tools/ })).toBeVisible();
    await expect(tab.getByRole('button', { name: 'Bearing & Dist.' })).toBeVisible();
    await gotoViewer(page);
    await openMapControlsTab(page, 'Measurement Tools');
    await expect(measureTab(page).getByRole('button', { name: 'Bearing & Dist.' })).toBeVisible();
  });

  test('Dimension Parcel shows its options only while it is the tool', async ({ page }) => {
    const tab = measureTab(page);
    await tab.getByRole('button', { name: /Advanced Tools/ }).click();
    await expect(tab.getByLabel('Label content')).toBeHidden();
    await tab.getByRole('button', { name: 'Dimension Parcel' }).click();
    await expect(tab.getByLabel('Label content')).toBeVisible();
    await expect(tab.getByLabel('Group name')).toHaveValue('{PIN} Dimensions');
    await tab.getByRole('button', { name: 'Dimension Parcel' }).click();
    await expect(tab.getByLabel('Label content')).toBeHidden();
  });

  test('Offset Line says it is coming', async ({ page }) => {
    await measureTab(page).getByRole('button', { name: /Advanced Tools/ }).click();
    const said = new Promise((resolve) => page.once('dialog', (d) => { resolve(d.message()); d.dismiss(); }));
    await measureTab(page).getByRole('button', { name: 'Offset Line' }).click();
    expect(await said).toBe('Offset Line is coming in a future update.');
  });

  test('Clear Measurements (confirmed) removes the measurements but not the drawings; undo follows', async ({ page }) => {
    const tab = measureTab(page);
    await page.evaluate(() => window.PS_ANNOTATION_STORE.addAnnotation({
      type: 'Feature', geometry: { type: 'Point', coordinates: [-86, 42.22] }, properties: { featureType: 'point', style: {} },
    }));
    await tab.getByRole('button', { name: 'Measure Dist.' }).click();
    for (const p of (await squareOnMap(page)).slice(0, 2)) await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Enter');
    await expect(tab.getByRole('button', { name: 'Undo (Ctrl+Z)' })).toBeEnabled();
    const kinds = () => page.evaluate(() => window.PS_ANNOTATION_STORE.getState().annotations.features
      .map((f) => (f.properties.featureType.startsWith('measure-') ? 'measure' : 'drawing')));
    expect(await kinds()).toContain('measure');
    page.once('dialog', (d) => d.accept());
    await tab.getByRole('button', { name: /Clear Measurements/ }).click();
    await expect.poll(kinds).toEqual(['drawing']);
  });

  test('dimension parcel: perimeter matches the parcel geometry', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const f = (window.PS_PARCEL_INDEX || [])[0];
      const full = await fetch('/api/parcel/' + f.properties.id).then((x) => x.json());
      window.PS_MEASURE_TOOL.dimensionParcel(full);
      await new Promise((res) => setTimeout(res, 600));
      return { expectedFt: turf.length(turf.polygonToLine(full), { units: 'feet' }) };
    });
    r.shown = await hudValue(page, 'Perimeter').textContent();
    const shownFt = /mi/.test(r.shown) ? num(r.shown) * 5280 : num(r.shown);
    expect(Math.abs(shownFt - r.expectedFt) / r.expectedFt).toBeLessThan(0.01);
  });
});

test.describe('Draw', () => {
  test.beforeEach(async ({ page }) => {
    await gotoViewer(page);
    await page.evaluate(() => { window.PS_MAP.jumpTo({ center: [-86.0, 42.22], zoom: 16 }); });
    await waitForMapIdle(page);
    await captureAnnotations(page);
    await openMapControlsTab(page, 'Drawing Tools');
  });

  test('polygon: click vertices + Enter creates one polygon annotation', async ({ page }) => {
    await drawTab(page).getByRole('button', { name: 'Shape', exact: true }).click();
    for (const p of await squareOnMap(page)) await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Enter');
    const types = await page.evaluate(() => window.__added.map((f) => f.geometry.type));
    expect(types).toEqual(['Polygon']);
  });

  test('undo removes the last drawing and redo brings it back', async ({ page }) => {
    await drawTab(page).getByRole('button', { name: 'Point', exact: true }).click();
    const [p] = await squareOnMap(page);
    await page.mouse.click(p.x, p.y);
    const count = () => annotationCount(page);
    const after = await count();
    await drawTab(page).getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
    expect(await count(), 'undo removes it').toBe(after - 1);
    await drawTab(page).getByRole('button', { name: 'Redo (Ctrl+Shift+Z)' }).click();
    expect(await count(), 'redo restores it').toBe(after);
  });

  test('a tool button turns its tool on, and pressing it again turns it off', async ({ page }) => {
    const active = () => page.evaluate(() => window.PS_DRAWING_TOOLS.getActiveDrawTool());
    await drawTab(page).getByRole('button', { name: 'Line', exact: true }).click();
    expect(await active()).toBe('polyline');
    await drawTab(page).getByRole('button', { name: 'Circle', exact: true }).click();
    expect(await active()).toBe('circle');
    await drawTab(page).getByRole('button', { name: 'Circle', exact: true }).click();
    expect(await active()).toBe(null);
  });

  test('a tool or style picked elsewhere (as Map Buddy does) shows in the pane', async ({ page }) => {
    const tab = drawTab(page);
    await page.evaluate(() => {
      window.PS_DRAWING_TOOLS.setActiveDrawTool('circle');
      window.PS_DRAWING_TOOLS.setStyle({ strokeWidth: 7 });
    });
    await expect(tab.getByRole('button', { name: 'Circle', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await tab.getByRole('button', { name: 'Style', exact: true }).click();
    await expect(tab.getByRole('slider', { name: 'Stroke width' })).toHaveValue('7');
  });

  test('the style picker sets the next drawing\'s stroke, width, dash and fill opacity', async ({ page }) => {
    const tab = drawTab(page);
    await expect(tab.getByRole('slider', { name: 'Stroke width' })).toBeHidden();
    await tab.getByRole('button', { name: 'Style', exact: true }).click();
    await tab.getByRole('button', { name: '#dc2626', exact: true }).click();
    await tab.getByRole('slider', { name: 'Stroke width' }).fill('4');
    await expect(tab.getByText('4px', { exact: true })).toBeVisible();
    await tab.getByRole('combobox', { name: 'Line style' }).selectOption('dashed');
    await tab.getByRole('slider', { name: 'Fill opacity' }).fill('50');
    await expect(tab.getByText('50%', { exact: true })).toBeVisible();
    await tab.getByRole('button', { name: 'Shape', exact: true }).click();
    for (const p of await squareOnMap(page)) await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Enter');
    const style = await page.evaluate(() => window.__added[0].properties.style);
    expect(style).toMatchObject({ strokeColor: '#dc2626', strokeWidth: 4, strokeDash: 'dashed', fillOpacity: 0.5 });
    await tab.getByRole('button', { name: 'Style', exact: true }).click();
    await expect(tab.getByRole('slider', { name: 'Stroke width' })).toBeHidden();
  });

  test('layer groups: a new group becomes active and takes new drawings; it hides and deletes', async ({ page }) => {
    const tab = drawTab(page);
    const store = () => page.evaluate(() => {
      const s = window.PS_ANNOTATION_STORE.getState();
      const last = s.annotations.features[s.annotations.features.length - 1];
      return { groups: s.layerGroups, active: s.activeLayerGroup, visible: s.layerVisibility, lastGroup: last && last.properties.layerGroup };
    });
    page.once('dialog', (d) => d.accept('Survey notes'));
    await tab.getByRole('button', { name: '+ New Group' }).click();
    await expect(tab.getByText('Survey notes', { exact: true })).toBeVisible();
    expect(await store()).toMatchObject({ groups: ['Default', 'Survey notes'], active: 'Survey notes' });
    await tab.getByRole('button', { name: 'Point', exact: true }).click();
    const [p] = await squareOnMap(page);
    await page.mouse.click(p.x, p.y);
    expect((await store()).lastGroup).toBe('Survey notes');
    await tab.getByTitle('Toggle visibility').nth(1).uncheck();
    expect((await store()).visible['Survey notes']).toBe(false);
    await tab.getByText('Default', { exact: true }).click();
    expect((await store()).active).toBe('Default');
    await tab.getByTitle('Delete group (annotations move to Default)').click();
    expect(await store()).toMatchObject({ groups: ['Default'], lastGroup: 'Default' });
    await expect(tab.getByText('Survey notes', { exact: true })).toHaveCount(0);
  });

  test('the Snapping and Grid checkboxes configure the snapping engine', async ({ page }) => {
    const cfg = () => page.evaluate(() => {
      const c = window.PS_SNAPPING_ENGINE.config;
      return { enabled: c.enabled, grid: c.targets.gridPoints };
    });
    await expect(drawTab(page).getByLabel('Snapping')).toBeChecked();
    expect(await cfg()).toEqual({ enabled: true, grid: false });
    await drawTab(page).getByLabel('Snapping').uncheck();
    await drawTab(page).getByLabel('Grid').check();
    expect(await cfg()).toEqual({ enabled: false, grid: true });
  });

  test('Clear all (confirmed) removes every drawing', async ({ page }) => {
    await drawTab(page).getByRole('button', { name: 'Point', exact: true }).click();
    for (const p of (await squareOnMap(page)).slice(0, 2)) await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Escape');
    page.once('dialog', (d) => d.accept());
    await drawTab(page).getByRole('button', { name: 'Clear', exact: true }).click();
    expect(await annotationCount(page)).toBe(0);
  });
});
