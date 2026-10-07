// What users see when a backend fails. Failures are simulated with request interception,
// so these are deterministic and need no containers stopped.
const { test, expect, gotoViewer, selectParcelViaSearch, ui } = require('./fixtures');

const mapError = (page) => page.getByRole('alert').filter({ hasText: 'The map couldn’t load' });

test('map style fails: an error card with a working Try again', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/style\.json|Failed to load resource|\[map\] failed to load/);
  let fail = true;
  await page.route('**/api/style.json', (route) => (fail ? route.fulfill({ status: 502, body: 'bad gateway' }) : route.continue()));
  await page.goto('/demo/');
  // Found by role=alert, so this also checks the card is announced.
  const card = mapError(page);
  await expect(card).toBeVisible();
  fail = false;
  await card.getByRole('button', { name: 'Try again' }).click();
  await page.waitForFunction(() => window.PS_MAP && window.PS_MAP.isStyleLoaded());
  await expect(mapError(page)).toHaveCount(0);
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
    await ui.searchInput(page).fill('paw paw');
    await expect(ui.searchResults(page).getByRole('alert')).toHaveText(text);
    await expect(page.getByTestId('parcel-search-status')).toHaveText(text);
  });
}

test('selecting a search result whose parcel fails to load tells the user', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/Failed to load resource/);
  await gotoViewer(page);
  await page.route(/\/api\/parcel\/\d+$/, (route) => route.fulfill({ status: 500, body: '{}' }));
  await ui.searchInput(page).fill('paw paw');
  await ui.searchResults(page).getByRole('option').first().click();
  // An announced toast must say it failed, rather than nothing happening (map.js notifyUser).
  await expect(page.getByRole('alert').filter({ hasText: /Couldn.t load that parcel/ })).toBeVisible();
});

test('Map Buddy down: the AI notice appears and the viewer keeps working', async ({ page, consoleGuard, mapBuddyOverride }) => {
  consoleGuard.allow(/map-buddy-api|Failed to load resource/);
  // Wherever Map Buddy lives: the dev proxy, or its own origin (E2E_MAP_BUDDY_API).
  const isMapBuddy = (url) => url.pathname.startsWith('/map-buddy-api/') ||
    (mapBuddyOverride && url.href.startsWith(mapBuddyOverride));
  await page.route(isMapBuddy, (route) => route.fulfill({ status: 502, body: '' }));
  await gotoViewer(page);
  await expect(page.getByRole('status').filter({ hasText: 'AI is unavailable' })).toBeVisible({ timeout: 20_000 });
  await selectParcelViaSearch(page);
});

test('a JavaScript error in the page is reported to the server (error beacon)', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/beacon-e2e-probe/);
  await gotoViewer(page);
  // Capture the beacon's body on its way through (sendBeacon bodies aren't exposed on
  // the plain request object), then let it reach the real server.
  let captured = null;
  await page.route('**/api/client-errors', async (route) => {
    captured = route.request().postDataBuffer();
    await route.continue();
  });
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/client-errors'));
  // Thrown from an inline <script>: counts as this site's own code.
  await page.addScriptTag({ content: 'setTimeout(function () { throw new Error("beacon-e2e-probe"); }, 0);' });
  expect((await answered).status()).toBe(204);
  const body = JSON.parse(captured.toString('utf8'));
  expect(body.kind).toBe('error');
  expect(body.message).toContain('beacon-e2e-probe');
  expect(body.page).toBe('/demo/');
});

test('errors from other sites (extensions, third-party scripts) are not reported', async ({ page }) => {
  await gotoViewer(page);
  let reported = false;
  page.on('request', (r) => { if (r.url().endsWith('/api/client-errors')) reported = true; });
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', {
    message: 'extension noise', filename: 'chrome-extension://abc/content.js', lineno: 1, colno: 1,
  })));
  await page.waitForTimeout(500);
  expect(reported).toBe(false);
});
