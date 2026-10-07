// Map Buddy's Automations palette (deterministic macros — no model call, no cost):
// every listed automation runs against the selected parcel and reports what it did;
// a refused input says why instead of claiming it ran.
const { test, expect, gotoViewer, selectParcelViaSearch, waitForMapIdle, ui } = require('./fixtures');

const chatLog = (page) => page.getByRole('log', { name: 'MapBuddy A.I. conversation' });
const palette = (page) => page.getByTestId('mb-auto-body');
// A run button is named by the humanized workflow id (check_buildability → "Check buildability").
const runButton = (page, name) => palette(page).getByRole('button', { name, exact: true });

async function openPalette(page) {
  await ui.mapBuddyButton(page).click();
  const toggle = page.getByRole('button', { name: /Automations/ });
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(palette(page)).toBeVisible();
}
// The last reply bubble's body (AI reply, map look read or info/result).
const lastAiMsg = (page) => chatLog(page).getByTestId('mb-msg-body').last();

test.beforeEach(async ({ page, consoleGuard }) => {
  // analyze_parcel / risk_overview turn on the federal overlays, whose tiles come
  // straight from FEMA / USFWS / NRCS; their outages aren't ours.
  consoleGuard.allow(/Failed to load resource.*(hazards\.fema\.gov|fwspublicservices|sdmdataaccess|wms-proxy)/);
  // USFWS answers headless browsers with a 500 that has no CORS header, which the browser
  // reports as a CORS block rather than a failed load (see map-vision.spec.js, DIC-2144).
  consoleGuard.allow(/fwspublicservices\.wim\.usgs\.gov.*blocked by CORS policy/);
  await gotoViewer(page);
  await selectParcelViaSearch(page);
});

test('every automation runs on the selected parcel and says so', async ({ page }) => {
  await openPalette(page);
  const names = (await palette(page).getByRole('button').allInnerTexts()).map((t) => t.trim());
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    await runButton(page, name).click();
    await expect(lastAiMsg(page), name).toContainText('Ran ', { timeout: 20_000 });
    await waitForMapIdle(page);
    // Close whatever the automation opened so the next one starts clean.
    await page.keyboard.press('Escape');
  }
});

test('Check buildability draws the requested setback', async ({ page }) => {
  await openPalette(page);
  await palette(page).getByLabel('Setback ft for Check buildability').fill('45');
  await runButton(page, 'Check buildability').click();
  await expect(lastAiMsg(page)).toContainText('Ran Check buildability', { timeout: 20_000 });
  await expect(chatLog(page).getByTestId(/^mb-msg-(ai|vision|info)$/).last()).toContainText('45 ft');
});

test('an out-of-range setback is refused with the reason (not "Ran …")', async ({ page }) => {
  await openPalette(page);
  await palette(page).getByLabel('Setback ft for Check buildability').fill('-30');
  await runButton(page, 'Check buildability').click();
  await expect(lastAiMsg(page)).toContainText('between 1 and 1000', { timeout: 20_000 });
  await expect(lastAiMsg(page)).not.toContainText('Ran ');
});
