// Compare: parcels added by PIN (as Map Buddy does) can be removed again.
const { test, expect, gotoViewer, selectParcelViaSearch, waitForSelectedInIndex, mapBuddy } = require('./fixtures');

test('compare by PIN: removing a column removes it (and it does not come back)', async ({ page }) => {
  await gotoViewer(page);
  await selectParcelViaSearch(page);
  await waitForSelectedInIndex(page);
  const pins = await page.evaluate(() => window.PS_PARCEL_INDEX.slice(0, 3).map((f) => f.properties.pin));
  await mapBuddy(page, [{ type: 'compare_parcels', payload: { pins } }]);
  const overlay = page.locator('.pv-compare-overlay');
  await expect(overlay).toBeVisible();
  const cols = overlay.locator('.pv-cmp-colx');
  await expect(cols).toHaveCount(3);
  await cols.first().click();
  await page.waitForTimeout(2000);                     // any re-fetch/re-render has landed
  await expect(overlay.locator('.pv-cmp-colx')).toHaveCount(2);
});

test('compare tray: the chip × removes a parcel added from the panel', async ({ page }) => {
  await gotoViewer(page);
  await selectParcelViaSearch(page);
  await page.locator('.pv-ptool[data-ptool="compare"]').first().click();
  const chip = page.locator('.pv-compare-chip');
  await expect(chip).toHaveCount(1);
  await chip.locator('.pv-compare-chip-x').click();
  await expect(page.locator('.pv-compare-tray')).toBeHidden();      // empty set hides the tray
  expect(await page.evaluate(() => window.PV_COMPARE.has(window.PS_STATE.parcel.id)), 'removed from the set').toBe(false);
});
