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

// The engine entry registers the v1 capabilities at boot, so ISV.invoke() works in the page
// (DIC-2266: it didn't, and PV_LEDGER.fetchLedger rejected with "unknown capability ledger").
test('the viewer registers the v1 capabilities and the ledger loads through them', async ({ page }) => {
  await page.route('**/api/parcel/*/history', (route) => route.fulfill({ json: { events: [] } }));
  await gotoViewer(page);

  const result = await page.evaluate(async () => ({
    ids: window.ISV.list().map((c) => c.id).sort(),
    ledger: await window.PV_LEDGER.fetchLedger(1).then((r) => r.facts.event_count, (e) => String(e)),
  }));

  expect(result.ids).toEqual(['cohort-analyze', 'explainer', 'ledger', 'theme-composer']);
  expect(result.ledger).toBe(0);
});
