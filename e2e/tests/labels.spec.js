// Parcel Labels tool: every label field renders real text on the map (no "NaN",
// "undefined", "$null"), sizes apply, and turning it off removes the labels.
const { test, expect, gotoViewer, waitForMapIdle } = require('./fixtures');

const FIELD_PROP = {        // label field → the per-feature property shown at zoom 15
  owner: '_z15', pin: '_pin_z15', address: '_addr_z15', acres: '_acresLbl',
  av: '_av', tv: '_tv', tmv: '_tmv', class: '_class',
};

async function openLabels(page) {
  await page.evaluate(() => window.PS_MAP.jumpTo({ center: [-85.905, 42.211], zoom: 15.2 }));
  await waitForMapIdle(page);
  if (!(await page.locator('#map-control-panel').isVisible())) await page.locator('#mcp-reopen-tab').click();
  await page.locator('.mcp-tab[data-tab="layers"]').click();
  await page.locator('#plbl-toggle').check();
  await expect(page.locator('#plbl-controls')).toBeVisible();
}

const rendered = (page, prop) => page.evaluate((prop) => {
  const m = window.PS_MAP;
  const layers = ['plbl-XL', 'plbl-MD', 'plbl-SM'].filter((id) => m.getLayer(id));
  return m.queryRenderedFeatures({ layers }).map((f) => f.properties[prop]);
}, prop);

test.beforeEach(async ({ page }) => { await gotoViewer(page); });

for (const [field, prop] of Object.entries(FIELD_PROP)) {
  test(`label field "${field}" renders clean text`, async ({ page }) => {
    await openLabels(page);
    await page.locator('#plbl-field').selectOption(field);
    await waitForMapIdle(page);
    await expect.poll(async () => (await rendered(page, prop)).length, { timeout: 10_000 }).toBeGreaterThan(5);
    const texts = (await rendered(page, prop)).filter((t) => t != null && t !== '');
    expect(texts.length, 'most labels have text').toBeGreaterThan(5);
    for (const t of texts) expect(String(t)).not.toMatch(/NaN|undefined|null|\[object/);
    if (field === 'acres') for (const t of texts) expect(t).toMatch(/^\d+\.\d\d ac$/);
    if (['av', 'tv', 'tmv'].includes(field)) for (const t of texts) expect(t).toMatch(/^\$[\d,]+$/);
  });
}

test('size buttons change label size; unchecking removes the labels', async ({ page }) => {
  await openLabels(page);
  await waitForMapIdle(page);
  const size = () => page.evaluate(() => JSON.stringify(window.PS_MAP.getLayoutProperty('plbl-XL', 'text-size')));
  const m = await size();
  await page.locator('.plbl-size-btn[data-size="large"]').click();
  await expect(page.locator('.plbl-size-btn[data-size="large"]')).toHaveClass(/active/);
  expect(await size()).not.toBe(m);
  await page.locator('#plbl-toggle').uncheck();
  await waitForMapIdle(page);
  expect((await rendered(page, '_z15')).length).toBe(0);
});
