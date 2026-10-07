// The window hooks the suite relies on exist (DIC-2180). This is the contract any refactor of
// the front end (ES modules, Vue) has to keep; see VIEWER_HOOKS in fixtures.js.
const { test, expect, gotoViewer, waitForMapIdle, VIEWER_HOOKS, ADMIN_HOOKS } = require('./fixtures');

test('the viewer exposes every hook the tests use', async ({ page }) => {
  await gotoViewer(page);
  await waitForMapIdle(page);
  await page.waitForFunction(() => Array.isArray(window.PS_PARCEL_INDEX), null, { timeout: 15_000 });

  const missing = await page.evaluate((names) => names.filter((n) => window[n] == null), Object.keys(VIEWER_HOOKS));

  expect(missing, 'window hooks the e2e suite reads').toEqual([]);
});

test('the admin console exposes its hook', async ({ page }) => {
  await page.goto('/admin/');

  const missing = await page.evaluate((names) => names.filter((n) => window[n] == null), Object.keys(ADMIN_HOOKS));

  expect(missing).toEqual([]);
});
