// Measurement results are right, and drawings behave (create, undo, redo, clear).
// Shapes are drawn with real mouse clicks on the map canvas.
const { test, expect, gotoViewer, waitForMapIdle, clickGate } = require('./fixtures');

async function openTab(page, tab) {
  if (!(await page.locator('#map-control-panel').isVisible())) await page.locator('#mcp-reopen-tab').click();
  const btn = page.locator(`.mcp-tab[data-tab="${tab}"]`);
  if (!(await btn.isVisible())) await page.locator('#mcp-advanced-toggle').click();
  await btn.click();
}

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
    await page.evaluate(() => window.PS_MAP.jumpTo({ center: [-86.0, 42.22], zoom: 16 }));
    await waitForMapIdle(page);
    await captureAnnotations(page);
    await openTab(page, 'measure');
  });

  test('area: the reported area matches the drawn shape', async ({ page }) => {
    await page.locator('#msr-tool-area').click();
    const pts = await squareOnMap(page);
    for (const p of pts) await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Enter');
    const hud = page.locator('#msr-hud');
    await expect(hud).toBeVisible();
    const shown = num((await hud.locator('tr', { hasText: 'Area' }).locator('td').last().innerText()).match(/([\d,]+) sq ft/)[1]);
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
    await page.locator('#msr-tool-coords').click();
    const box = await page.locator('canvas.maplibregl-canvas').boundingBox();
    await page.mouse.click(box.x + box.width / 2 + 120, box.y + box.height / 2);
    const copies = page.locator('#msr-hud .msr-copy-btn');
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
    await page.locator('#msr-tool-dist').click();
    const pts = (await squareOnMap(page)).slice(0, 3);
    for (const p of pts) await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Enter');
    const cell = page.locator('#msr-hud tr', { hasText: 'Total Distance' }).locator('td').last();
    await expect(cell).toBeVisible();
    const text = await cell.innerText();
    const shownFt = /mi/.test(text) ? num(text) * 5280 : num(text);
    const expectedFt = await page.evaluate((c) => turf.distance(c[0], c[1], { units: 'feet' }) + turf.distance(c[1], c[2], { units: 'feet' }), pts.map((p) => p.lngLat));
    expect(Math.abs(shownFt - expectedFt) / expectedFt).toBeLessThan(0.05);
  });

  test('Clear This Measurement removes it and Esc releases the map', async ({ page }) => {
    await page.locator('#msr-tool-area').click();
    for (const p of await squareOnMap(page)) await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Enter');
    await page.locator('#msr-clear-last-btn').click();
    await page.keyboard.press('Escape');
    expect(await clickGate(page)).toBeNull();
  });

  test('dimension parcel: perimeter matches the parcel geometry', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const f = (window.PS_PARCEL_INDEX || [])[0];
      const full = await fetch('/api/parcel/' + f.properties.id).then((x) => x.json());
      window.PS_MEASURE_TOOL.dimensionParcel(full);
      await new Promise((res) => setTimeout(res, 600));
      const cell = [...document.querySelectorAll('#msr-hud tr')].find((tr) => /Perimeter/.test(tr.textContent));
      return { shown: cell && cell.lastElementChild.textContent, expectedFt: turf.length(turf.polygonToLine(full), { units: 'feet' }) };
    });
    const shownFt = /mi/.test(r.shown) ? num(r.shown) * 5280 : num(r.shown);
    expect(Math.abs(shownFt - r.expectedFt) / r.expectedFt).toBeLessThan(0.01);
  });
});

test.describe('Draw', () => {
  test.beforeEach(async ({ page }) => {
    await gotoViewer(page);
    await page.evaluate(() => window.PS_MAP.jumpTo({ center: [-86.0, 42.22], zoom: 16 }));
    await waitForMapIdle(page);
    await captureAnnotations(page);
    await openTab(page, 'draw');
  });

  test('polygon: click vertices + Enter creates one polygon annotation', async ({ page }) => {
    await page.locator('#drw-tool-polygon').click();
    for (const p of await squareOnMap(page)) await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Enter');
    const types = await page.evaluate(() => window.__added.map((f) => f.geometry.type));
    expect(types).toEqual(['Polygon']);
  });

  test('undo removes the last drawing and redo brings it back', async ({ page }) => {
    await page.locator('#drw-tool-point').click();
    const [p] = await squareOnMap(page);
    await page.mouse.click(p.x, p.y);
    const count = () => page.evaluate(() => {
      const src = window.PS_MAP.getSource('annotation-source');
      return src && src._data && src._data.features ? src._data.features.length : null;
    });
    const after = await count();
    await page.locator('#drw-undo-btn').click();
    expect(await count(), 'undo removes it').toBe(after - 1);
    await page.locator('#drw-redo-btn').click();
    expect(await count(), 'redo restores it').toBe(after);
  });

  test('Clear all (confirmed) removes every drawing', async ({ page }) => {
    await page.locator('#drw-tool-point').click();
    for (const p of (await squareOnMap(page)).slice(0, 2)) await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Escape');
    page.once('dialog', (d) => d.accept());
    await page.locator('#drw-clear-all-btn').click();
    const left = await page.evaluate(() => {
      const src = window.PS_MAP.getSource('annotation-source');
      return src && src._data && src._data.features ? src._data.features.length : 0;
    });
    expect(left).toBe(0);
  });
});
