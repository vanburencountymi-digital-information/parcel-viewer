// "Color parcels by" views (Layers → Parcels ►): each view repaints, shows a legend,
// shades parcels from the right values, and the choice survives a reload.
const { test, expect, gotoViewer, waitForMapIdle } = require('./fixtures');

async function openViews(page) {
  await page.evaluate(() => window.PS_MAP.jumpTo({ center: [-85.905, 42.211], zoom: 15 }));
  await waitForMapIdle(page);
  if (!(await page.locator('#map-control-panel').isVisible())) await page.locator('#mcp-reopen-tab').click();
  await page.locator('.mcp-tab[data-tab="layers"]').click();
  const chev = page.locator('.lyr-chevron[data-target="parcels-choro-body"]');
  if ((await chev.getAttribute('aria-expanded')) !== 'true') await chev.click();
  await expect(page.locator('#parcels-choro-views')).toBeVisible();
}
const pick = (page, id) => page.locator(`#parcels-choro-views input[value="${id}"]`).check();
const fill = (page) => page.evaluate(() => JSON.stringify(window.PS_MAP.getPaintProperty('parcels-fill', 'fill-color')));

test.beforeEach(async ({ page }) => { await gotoViewer(page); });

test('every view repaints and shows a legend; Plain hides both', async ({ page }) => {
  await openViews(page);
  const ids = await page.locator('#parcels-choro-views input').evaluateAll((els) => els.map((e) => e.value));
  expect(ids).toEqual(expect.arrayContaining(['class', 'acreage', 'tmv_acre', 'school', 'none']));
  const seen = new Set();
  for (const id of ids) {
    await pick(page, id);
    await waitForMapIdle(page);
    const legend = page.locator('#parcels-choro-legend');
    if (id === 'none') {
      await expect(legend).toBeHidden();
      continue;
    }
    await expect(legend, `${id} legend`).toBeVisible();
    await expect(legend.locator('.choropleth-legend-row').first()).toBeVisible();
    seen.add(await fill(page));
  }
  expect(seen.size, 'each view paints differently').toBe(ids.length - 1);
});

test('taxable value / acre shades rendered parcels with their own values', async ({ page }) => {
  await openViews(page);
  await pick(page, 'tmv_acre');
  await waitForMapIdle(page);
  await expect.poll(() => page.evaluate(() => {
    const m = window.PS_MAP;
    const byPin = new Map(window.PS_PARCEL_INDEX.map((f) => [String(f.properties.pin), f.properties]));
    let checked = 0, wrong = [];
    for (const f of m.querySourceFeatures('parcels', { sourceLayer: 'parcels' })) {
      const p = byPin.get(String(f.id)); if (!p) continue;
      const tv = +p.taxable_value, ac = +p.gis_acres;
      if (!(tv > 0 && ac > 0)) continue;
      const st = m.getFeatureState({ source: 'parcels', sourceLayer: 'parcels', id: f.id });
      checked++;
      if (Math.abs(st.tmv_acre - tv / ac) > 0.01) wrong.push(f.id);
    }
    return checked > 20 && wrong.length === 0 ? 'ok' : `checked ${checked}, wrong ${wrong.length}`;
  }), { timeout: 15_000 }).toBe('ok');
});

test('school district legend lists the districts present, and the choice persists', async ({ page }) => {
  await openViews(page);
  await pick(page, 'school');
  await waitForMapIdle(page);
  const expected = await page.evaluate(() => [...new Set(window.PS_PARCEL_INDEX
    .map((f) => f.properties.school_dist).filter((v) => v != null && v !== '').map(String))]);
  expect(expected.length).toBeGreaterThan(0);
  await expect.poll(async () => {
    const legend = await page.locator('#parcels-choro-legend').innerText();
    return expected.filter((d) => !legend.includes(d));
  }, { message: 'districts missing from the legend' }).toEqual([]);
  await gotoViewer(page);
  await openViews(page);
  await expect(page.locator('#parcels-choro-views input[value="school"]')).toBeChecked();
  await expect(page.locator('#parcels-choro-legend')).toContainText('School district');
});

test('Plain view: selecting a parcel keeps the other parcels visible', async ({ page }) => {
  await openViews(page);
  await pick(page, 'none');
  await page.evaluate(async () => {
    await window.PS_selectParcelById(window.PS_PARCEL_INDEX[5].properties.id, { keepView: true });
  });
  await waitForMapIdle(page);
  const r = await page.evaluate(() => {
    const m = window.PS_MAP;
    const unselected = (id) => { const v = m.getPaintProperty(id, 'line-opacity'); return Array.isArray(v) ? v[v.length - 1] : v; };
    return { line: unselected('parcels-line'), casing: m.getLayer('parcels-line-casing') ? unselected('parcels-line-casing') : null };
  });
  expect(r.line, 'unselected outline opacity (was 0.18 → parcels vanished)').toBeGreaterThanOrEqual(0.5);
  expect(r.casing, 'casing present and visible').toBeGreaterThanOrEqual(0.3);
});

test('parcel outline adapts to the background: dark on light, softened white on dark and aerial', async ({ page }) => {
  const style = () => page.evaluate(() => ({
    line: window.PS_MAP.getPaintProperty('parcels-line', 'line-color'),
    casing: window.PS_MAP.getPaintProperty('parcels-line-casing', 'line-color'),
    op: window.PS_MAP.getPaintProperty('parcels-line', 'line-opacity'),
  }));
  const light = await style();
  expect(light.line).not.toBe('#ffffff');
  expect(light.casing).toBe('#ffffff');
  await page.locator('#theme-toggle').click();
  await expect.poll(style).toMatchObject({ line: '#ffffff', casing: '#111827' });
  expect((await style()).op, 'white is toned down on dark').toBeLessThan(light.op);
  await page.locator('#theme-toggle').click();                       // back to light…
  await expect.poll(async () => (await style()).line).toBe(light.line);
  await openViews(page);
  await page.locator('#toggle-aerial').check();                        // …then aerial
  await expect.poll(async () => (await style()).line).toBe('#ffffff');
  await page.locator('#toggle-aerial').uncheck();
  await expect.poll(async () => (await style()).line).toBe(light.line);
});

test('dark mode swaps the view to its dark palette', async ({ page }) => {
  await openViews(page);
  await pick(page, 'class');
  await waitForMapIdle(page);
  const light = await fill(page);
  await page.locator('#theme-toggle').click();
  await expect.poll(() => fill(page)).not.toBe(light);
  await expect(page.locator('#parcels-choro-views input[value="class"]')).toBeChecked();
});
