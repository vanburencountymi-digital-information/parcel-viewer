// Settings that change what the viewer displays: area units, coordinate format, default
// basemap. Each must apply immediately to what's on screen and survive a reload.
const { test, expect, gotoViewer, selectParcelViaSearch, waitForMapIdle, ui } = require('./fixtures');

const settings = (page) => page.getByRole('dialog', { name: 'Settings' });
async function openSettings(page) {
  await ui.helpMenuButton(page).click();
  await ui.helpMenu(page).getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await expect(settings(page).getByLabel('Area units')).toBeVisible();
}
// The Layers pane's aerial checkbox (by label, so it's found even while the pane is collapsed).
const aerialToggle = (page) => page.getByLabel('Aerial Imagery', { exact: true });
const closeModal = (page) => page.keyboard.press('Escape');
const areaText = (page) => ui.parcelPanel(page).innerText().then((t) => (t.match(/Area\s*\n?\s*([^\n]+)/) || [])[1]);
const centerText = (page) => ui.parcelPanel(page).innerText().then((t) => (t.match(/Center\s*\n?\s*([^\n]+)/) || [])[1]);

test.beforeEach(async ({ page }) => {
  await gotoViewer(page);
  await selectParcelViaSearch(page);
});

test('area units: switching to square feet updates the open panel and persists', async ({ page }) => {
  const acres = await areaText(page);
  expect(acres).toMatch(/ ac/);
  await openSettings(page);
  await settings(page).getByLabel('Area units').selectOption('sqft');
  await closeModal(page);
  const sqft = await areaText(page);
  expect(sqft).toMatch(/^[\d,]+ sq ft$/);
  // Same area, different units (43,560 sq ft per acre; the panel rounds acres to 0.01).
  const ac = parseFloat(acres), ft = Number(sqft.replace(/[^\d]/g, ''));
  expect(Math.abs(ft / 43560 - ac)).toBeLessThan(0.006);
  await gotoViewer(page);
  await selectParcelViaSearch(page);
  expect(await areaText(page)).toMatch(/sq ft$/);
});

test('coordinate format: the Settings choice re-renders the open panel\'s Center', async ({ page }) => {
  const dd = await centerText(page);
  expect(dd).toMatch(/°N/);
  await openSettings(page);
  await settings(page).getByLabel('Coordinate format').selectOption('spc');
  await closeModal(page);
  await expect.poll(() => centerText(page)).toMatch(/^N [\d,]+\s+E [\d,]+ ft$/);
  await openSettings(page);
  await settings(page).getByLabel('Coordinate format').selectOption('dms');
  await closeModal(page);
  await expect.poll(() => centerText(page)).toMatch(/°\d\d'\d\d"N/);
});

test('coordinate readout: DMS and State Plane agree with decimal degrees', async ({ page }) => {
  const r = {};
  for (const f of ['dd', 'dms', 'spc']) {
    await page.evaluate((f) => {
      window.PV_COORDS.setFormat(f);
      window.PS_MAP.fire('mousemove', { lngLat: { lng: -85.905, lat: 42.211 }, point: { x: 1, y: 1 } });
    }, f);
    r[f] = await page.getByLabel('Cursor coordinates').textContent();
  }
  r.spcRef = await page.evaluate(() => {
    return window.proj4('+proj=longlat +datum=WGS84 +no_defs',
      '+proj=lcc +lat_0=41.5 +lon_0=-84.3666666666667 +lat_1=42.1 +lat_2=43.6667 +x_0=4000000 +y_0=0 +ellps=GRS80 +units=us-ft +no_defs',
      [-85.905, 42.211]);
  });
  expect(r.dd).toBe('42.21100°N  85.90500°W');
  expect(r.dms).toBe('42°12\'40"N  85°54\'18"W');
  const [, n, e] = r.spc.match(/N ([\d,]+)\s+E ([\d,]+) ft/);
  expect(Number(n.replace(/,/g, ''))).toBe(Math.round(r.spcRef[1]));
  expect(Number(e.replace(/,/g, ''))).toBe(Math.round(r.spcRef[0]));
});

test('default basemap: aerial applies now and after a reload', async ({ page }) => {
  await openSettings(page);
  await settings(page).getByLabel('Default basemap').selectOption('aerial');
  await closeModal(page);
  await expect(aerialToggle(page)).toBeChecked();
  await gotoViewer(page);
  await expect(aerialToggle(page)).toBeChecked();
  // And back to light turns aerial off.
  await openSettings(page);
  await settings(page).getByLabel('Default basemap').selectOption('light');
  await closeModal(page);
  await expect(aerialToggle(page)).not.toBeChecked();
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).not.toBe('dark');
});

test('colour scheme, panel glass and accessibility apply now and after a reload', async ({ page }) => {
  const html = (fn) => page.evaluate(fn);
  await openSettings(page);
  const dlg = settings(page);
  // A click on the field's own text picks nothing (it used to pick the first swatch).
  await dlg.getByText('Color scheme', { exact: true }).click();
  await expect(dlg.getByRole('button', { name: 'Terracotta color scheme' })).toHaveAttribute('aria-pressed', 'true');
  await dlg.getByRole('button', { name: 'Forest color scheme' }).click();
  await expect(dlg.getByRole('button', { name: 'Forest color scheme' })).toHaveAttribute('aria-pressed', 'true');
  await dlg.getByLabel('Panel transparency, lower is more see-through').fill('80');
  await dlg.getByLabel('High contrast').check();
  await dlg.getByLabel('Text size').selectOption('1.15');
  await closeModal(page);
  const state = () => html(() => ({
    scheme: document.documentElement.getAttribute('data-scheme'),
    glass: document.documentElement.style.getPropertyValue('--glass-alpha').trim(),
    contrast: document.documentElement.classList.contains('pv-a11y-contrast'),
    large: document.documentElement.classList.contains('pv-a11y-large'),
  }));
  const want = { scheme: 'forest', glass: '0.8', contrast: true, large: true };
  expect(await state()).toEqual(want);
  await gotoViewer(page);
  expect(await state()).toEqual(want);
  // And the window shows what was saved.
  await openSettings(page);
  await expect(dlg.getByLabel('High contrast')).toBeChecked();
  await expect(dlg.getByLabel('Text size')).toHaveValue('1.15');
  await expect(dlg.getByLabel('Panel transparency, lower is more see-through')).toHaveValue('80');
});

test('the header button reflects accessibility set in Settings', async ({ page }) => {
  const btn = page.getByRole('button', { name: 'Toggle maximum accessibility' });
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await openSettings(page);
  const dlg = settings(page);
  for (const name of ['High contrast', 'Reduce transparency', 'Legible font', 'Reduce motion']) await dlg.getByLabel(name).check();
  await dlg.getByLabel('Text size').selectOption('1.3');
  await closeModal(page);   // the page behind an open dialog is inert, the button with it
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await openSettings(page);
  await dlg.getByLabel('Reduce motion').uncheck();
  await closeModal(page);
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
});
