// Search box -> results -> parcel info panel, driven through the real UI.
const { test, expect, gotoViewer, selectParcelViaSearch, selectedPin } = require('./fixtures');

test.beforeEach(async ({ page }) => { await gotoViewer(page); });

test('search shows results and selecting one opens the parcel panel', async ({ page }) => {
  const pin = await selectParcelViaSearch(page, 'paw paw');
  const panel = page.locator('#parcel-info-panel');
  for (const section of ['Parcel', 'Owner', 'Assessed Values', 'Tax Description']) {
    await expect(panel.locator('.parcel-info-section-title', { hasText: section }).first()).toBeVisible();
  }
  expect(await selectedPin(page)).toBe(pin);
});

test('keyboard: arrow down + Enter selects a result; Escape closes the list', async ({ page }) => {
  const input = page.locator('#parcel-search-input');
  await input.fill('paw paw');
  await expect(page.locator('.parcel-search-result').first()).toBeVisible();
  await input.press('ArrowDown');
  await expect(page.locator('.parcel-search-result[aria-selected="true"]')).toHaveCount(1);
  await input.press('Enter');
  await expect(page.locator('#parcel-info-panel')).toBeVisible();
  await input.fill('paw paw');
  await expect(page.locator('.parcel-search-result').first()).toBeVisible();
  await input.press('Escape');
  await expect(page.locator('#parcel-search-results')).toBeHidden();
});

test('search with no matches says so', async ({ page }) => {
  await page.locator('#parcel-search-input').fill('zzqqxxnomatch');
  await expect(page.locator('.parcel-search-no-results')).toHaveText(/No matches/);
});

test('clearing the query below 2 chars does not bring stale results back', async ({ page }) => {
  const input = page.locator('#parcel-search-input');
  await input.fill('paw');
  await input.press('Backspace');
  await input.press('Backspace');           // "p" — below the 2-char minimum
  await page.waitForTimeout(1500);          // longer than the debounce + a search round-trip
  await expect(page.locator('.parcel-search-result')).toHaveCount(0);
});

test('the panel close button clears the selection', async ({ page }) => {
  await selectParcelViaSearch(page);
  const panel = page.locator('#parcel-info-panel');
  await panel.locator('.parcel-info-close').click();
  await expect(panel).toBeHidden();
  expect(await selectedPin(page)).toBeNull();
});

test('Escape inside a dialog closes the dialog but keeps the parcel selected', async ({ page }) => {
  const pin = await selectParcelViaSearch(page);
  await page.locator('.pv-info-btn[data-info="assess"]').first().click();
  const modal = page.locator('.pv-modal-backdrop');
  await expect(modal).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  expect(await selectedPin(page)).toBe(pin);
  await expect(page.locator('#parcel-info-panel')).toBeVisible();
});
