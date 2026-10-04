// Real mouse clicks on the map canvas select parcels.
const { test, expect, gotoViewer, selectParcelViaSearch, selectedParcelPoint, selectedPin, waitForSelectedInIndex } = require('./fixtures');

test('clicking a parcel on the map selects it', async ({ page }) => {
  await gotoViewer(page);
  const pin = await selectParcelViaSearch(page);
  await waitForSelectedInIndex(page);
  const pt = await selectedParcelPoint(page);
  expect(pt, 'selected parcel is in the loaded index').not.toBeNull();
  // Deselect, then click the same parcel on the canvas.
  await page.locator('#parcel-info-panel .parcel-info-close').click();
  expect(await selectedPin(page)).toBeNull();
  await page.mouse.click(pt.x, pt.y);
  await expect(page.locator('#parcel-info-panel')).toBeVisible();
  await expect(page.locator('.parcel-info-pin')).toHaveText(pin);
});
