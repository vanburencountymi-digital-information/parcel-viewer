// Neighborhood Profile: every area type produces a profile with a real parcel count.
const { test, expect, gotoViewer, selectParcelViaSearch, waitForMapIdle } = require('./fixtures');

const sub = (page) => page.locator('#pv-profile-overlay #pv-profile-sub');
const countOf = async (page) => {
  const m = (await sub(page).innerText()).match(/(\d[\d,]*) parcels?/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
};

async function openProfile(page) {
  await page.locator('.pv-ptool[data-ptool="profile"]').first().click();
  await expect(page.locator('#pv-profile-overlay')).toBeVisible();
  await expect(sub(page)).toContainText(/parcels?/, { timeout: 20_000 });
}

// The Profile samples flood/wetland/soil at the area centre through /api/wms-proxy to
// federal services (FEMA, USFWS, NRCS). Those occasionally fail (seen: intermittent FEMA
// 502s); the Profile degrades gracefully, so that third-party outage isn't our failure.
const FEDERAL_VIA_PROXY = /Failed to load resource.*\[.*\/api\/wms-proxy\?url=https%3A%2F%2F(hazards\.fema\.gov|fwspublicservices|sdmdataaccess)/;

let pin;
test.beforeEach(async ({ page, consoleGuard }) => {
  consoleGuard.allow(FEDERAL_VIA_PROXY);
  await gotoViewer(page);
  pin = await selectParcelViaSearch(page);
  await openProfile(page);
});

test('around this parcel: every radius gives a count, and bigger radii never give fewer', async ({ page }) => {
  const radii = page.locator('#pv-profile-overlay [data-ft]');
  const n = await radii.count();
  expect(n).toBeGreaterThan(1);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const ft = await radii.nth(i).getAttribute('data-ft');
    await radii.nth(i).click();
    await expect(sub(page)).toContainText(new RegExp('Within ' + Number(ft).toLocaleString('en-US') + ' ft|Within ' + ft + ' ft'), { timeout: 20_000 });
    const label = ft + ' ft';
    const c = await countOf(page);
    expect(c, `count for ${label}`).toBeGreaterThan(0);
    await expect(sub(page), 'labelled by parcel number, not DB id').toContainText(pin);
    expect(c, `${label} is at least the smaller radius`).toBeGreaterThanOrEqual(last);
    last = c;
  }
});

test('rapid radius changes settle on the last one chosen', async ({ page }) => {
  const radii = page.locator('#pv-profile-overlay [data-ft]');
  const n = await radii.count();
  for (let i = 0; i < n; i++) await radii.nth(i).click();          // no waiting between clicks
  await radii.nth(0).click();
  const ft = await radii.nth(0).getAttribute('data-ft');
  await page.waitForTimeout(6000);                                  // let every in-flight response land
  await expect(sub(page)).toContainText(new RegExp('Within (' + ft + '|' + Number(ft).toLocaleString('en-US') + ') ft'));
});

for (const mode of ['subdivision', 'section', 'township', 'school']) {
  test(`${mode}: picking one gives a profile`, async ({ page }) => {
    await page.locator('#pv-prof-mode').selectOption(mode);
    const geo = page.locator('#pv-prof-geo');
    await expect(geo).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => geo.locator('option').count(), { timeout: 15_000 }).toBeGreaterThan(1);
    const value = await geo.locator('option').nth(1).getAttribute('value');
    await geo.selectOption(value);
    await expect.poll(() => countOf(page), { timeout: 30_000 }).toBeGreaterThan(0);
  });
}

test('draw an area: drawing a polygon produces a profile for it', async ({ page }) => {
  await page.locator('#pv-prof-mode').selectOption('drawn');
  // Selecting the mode shows a "Draw an area" button; that starts drawing on the map.
  await page.locator('#pv-profile-overlay #pv-prof-mode-ctl').getByRole('button', { name: /Draw an area/ }).click();
  await expect(page.locator('#pv-profile-overlay')).toBeHidden();
  expect(await page.evaluate(() => (window.PS_STATE || {}).activeDrawTool), 'polygon tool armed').toBe('polygon');
  await page.evaluate(() => { window.__polys = 0; const S = window.PS_ANNOTATION_STORE, o = S.addAnnotation;
    S.addAnnotation = function (f) { if (f && f.geometry && f.geometry.type === 'Polygon') window.__polys++; return o.apply(this, arguments); }; });
  const pts = await page.evaluate(() => {
    const m = window.PS_MAP, r = m.getCanvas().getBoundingClientRect();
    const cx = r.width / 2 + 120, cy = r.height / 2, h = 120;
    return [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]].map(([x, y]) => ({ x: r.left + x, y: r.top + y }));
  });
  for (const p of pts) { await page.mouse.click(p.x, p.y); await page.waitForTimeout(150); }
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__polys), { message: 'a polygon was created' }).toBe(1);
  await expect(page.locator('#pv-profile-overlay')).toBeVisible({ timeout: 15_000 });
  await expect(sub(page)).toContainText(/drawn area/i, { timeout: 30_000 });
  expect(await countOf(page)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window.PS_STATE || {}).activeDrawTool || null), 'tool put away').toBeNull();
});
