// Phone viewport (Pixel 7): the mobile tab bar, search overlay and parcel panel work.
const { test, expect, gotoViewer } = require('./fixtures');

test('mobile: tab bar, search overlay, select a parcel', async ({ page }) => {
  await gotoViewer(page);
  await expect(page.locator('#pv-mobile-tabbar')).toBeVisible();
  await page.locator('#pv-search-btn').click();
  const input = page.locator('#parcel-search-input');
  await expect(input).toBeVisible();
  await input.fill('paw paw');
  const first = page.locator('.parcel-search-result').first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page.locator('#parcel-info-panel')).toBeVisible();
  // No horizontal overflow on a phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('mobile: each bottom tab opens its panel', async ({ page }) => {
  await gotoViewer(page);
  for (const id of ['pv-mtab-controls', 'pv-mtab-buddy', 'pv-mtab-parcel']) {
    const tab = page.locator('#' + id);
    if (!(await tab.isVisible()) || await tab.isDisabled()) continue;
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }
});
