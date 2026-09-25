// Map Buddy's Automations palette (deterministic macros — no model call, no cost):
// every listed automation runs against the selected parcel and reports what it did;
// a refused input says why instead of claiming it ran.
const { test, expect, gotoViewer, selectParcelViaSearch, waitForMapIdle } = require('./fixtures');

async function openPalette(page) {
  await page.locator('#mb-tab-btn').click();
  const toggle = page.locator('#mb-auto-toggle');
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.locator('#mb-auto-body')).toBeVisible();
}
const lastAiMsg = (page) => page.locator('.mb-msg-ai-body').last();

test.beforeEach(async ({ page, consoleGuard }) => {
  // analyze_parcel / risk_overview turn on the federal overlays, whose tiles come
  // straight from FEMA / USFWS / NRCS; their outages aren't ours.
  consoleGuard.allow(/Failed to load resource.*(hazards\.fema\.gov|fwspublicservices|sdmdataaccess|wms-proxy)/);
  await gotoViewer(page);
  await selectParcelViaSearch(page);
});

test('every automation runs on the selected parcel and says so', async ({ page }) => {
  await openPalette(page);
  const ids = await page.locator('.mb-auto-run').evaluateAll((b) => b.map((x) => x.dataset.wf));
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    await page.locator(`.mb-auto-run[data-wf="${id}"]`).click();
    await expect(lastAiMsg(page), id).toContainText('Ran ', { timeout: 20_000 });
    await waitForMapIdle(page);
    // Close whatever the automation opened so the next one starts clean.
    await page.keyboard.press('Escape');
  }
});

test('Check buildability draws the requested setback', async ({ page }) => {
  await openPalette(page);
  await page.locator('.mb-auto-row[data-wf="check_buildability"] .mb-auto-input').fill('45');
  await page.locator('.mb-auto-run[data-wf="check_buildability"]').click();
  await expect(lastAiMsg(page)).toContainText('Ran Check buildability', { timeout: 20_000 });
  await expect(page.locator('.mb-msg-ai').last()).toContainText('45 ft');
});

test('an out-of-range setback is refused with the reason (not "Ran …")', async ({ page }) => {
  await openPalette(page);
  await page.locator('.mb-auto-row[data-wf="check_buildability"] .mb-auto-input').fill('-30');
  await page.locator('.mb-auto-run[data-wf="check_buildability"]').click();
  await expect(lastAiMsg(page)).toContainText('between 1 and 1000', { timeout: 20_000 });
  await expect(lastAiMsg(page)).not.toContainText('Ran ');
});
