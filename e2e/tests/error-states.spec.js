// What users see when a backend fails. Failures are simulated with request interception,
// so these are deterministic and need no containers stopped.
const { test, expect, gotoViewer, selectParcelViaSearch } = require('./fixtures');

test('map style fails: an error card with a working Try again', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/style\.json|Failed to load resource|\[map\] failed to load/);
  let fail = true;
  await page.route('**/api/style.json', (route) => (fail ? route.fulfill({ status: 502, body: 'bad gateway' }) : route.continue()));
  await page.goto('/demo/');
  const card = page.locator('#pv-map-error');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('role', 'alert');
  fail = false;
  await card.getByRole('button', { name: 'Try again' }).click();
  await page.waitForFunction(() => window.PS_MAP && window.PS_MAP.isStyleLoaded());
  await expect(page.locator('#pv-map-error')).toHaveCount(0);
});

test('served config fails: falls back to the baked config', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/config\.js|Failed to load resource/);
  await page.route('**/api/config.js', (route) => route.fulfill({ status: 500, body: '' }));
  await gotoViewer(page);
  expect(await page.evaluate(() => window.PV_CONFIG_SOURCE)).toBe('fallback');
  expect(await page.evaluate(() => window.COUNTY && window.COUNTY.tenant)).toBe('vanburen');
});

for (const [status, text] of [[500, /Search is unavailable/], [429, /Too many searches/]]) {
  test(`search returns ${status}: a visible, announced message`, async ({ page, consoleGuard }) => {
    consoleGuard.allow(/Failed to load resource/);
    await gotoViewer(page);
    await page.route('**/api/search?**', (route) => route.fulfill({ status, body: '{}' }));
    await page.locator('#parcel-search-input').fill('paw paw');
    await expect(page.locator('.parcel-search-error')).toHaveText(text);
    await expect(page.locator('#parcel-search-status')).toHaveText(text);
  });
}

test('selecting a search result whose parcel fails to load tells the user', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/Failed to load resource/);
  await gotoViewer(page);
  await page.route(/\/api\/parcel\/\d+$/, (route) => route.fulfill({ status: 500, body: '{}' }));
  await page.locator('#parcel-search-input').fill('paw paw');
  await page.locator('.parcel-search-result').first().click();
  // Something visible must say it failed (a toast or message), rather than nothing happening.
  await expect(page.locator('.pv-toast, [role="alert"]').filter({ hasText: /couldn|fail|unavailable|try again/i }).first()).toBeVisible();
});

test('Map Buddy down: the AI notice appears and the viewer keeps working', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/map-buddy-api|Failed to load resource/);
  await page.route('**/map-buddy-api/**', (route) => route.fulfill({ status: 502, body: '' }));
  await gotoViewer(page);
  await expect(page.locator('#pv-ai-notice')).toBeVisible({ timeout: 20_000 });
  await selectParcelViaSearch(page);
});
