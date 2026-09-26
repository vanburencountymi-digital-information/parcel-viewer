// Assessed-value history year labels follow the tax roll in the data, not the calendar
// (DIC-1878). The parcel response is rewritten to say its history ends at the 2023 roll
// (today's data ends at the 2026 roll, loaded in 2026), so a calendar-based label would
// show 2026 and fail. The Map Buddy service is mocked: no model calls.
const { test, expect, gotoViewer, selectParcelViaSearch } = require('./fixtures');

const PARCEL = /\/api\/parcel\/\d+$/;
const EXPLAIN = /\/explain(\?|$)/;
const HEALTH = /\/health(\?|$)/;

// The routes below fetch the real response; one may still be in flight when a test ends.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }); });

// Rewrite /api/parcel/{id} so the data says its history ends at `rollYear`.
async function dataRollYear(page, rollYear) {
  await page.route(PARCEL, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.properties.roll_year = rollYear;
    await route.fulfill({ response: res, json: body });
  });
}

// Mock Map Buddy (AI on) and capture what the explainer sends it.
async function captureExplain(page) {
  const sent = [];
  await page.addInitScript(() => { try { localStorage.setItem('pv-ai-mode', 'on'); } catch (_) {} });
  await page.route(HEALTH, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.route(EXPLAIN, (r) => {
    sent.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, explanation: {
      summary: 'Mock.', sections: [], glossary: [], statutes: [], disclaimer: 'Educational only.' } }) });
  });
  return sent;
}

// The four-digit year labels in an SVG chart, left (oldest) to right (newest).
function yearLabels(svg) {
  return svg.locator('text').evaluateAll((els) => els.map((e) => e.textContent.trim()).filter((t) => /^\d{4}$/.test(t)).map(Number));
}

// Find the facts object in the explain request, wherever the client nests it.
function findFacts(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if ('assessed_value_by_year' in obj) return obj;
  for (const v of Object.values(obj)) { const f = findFacts(v); if (f) return f; }
  return null;
}

test('the panel chart, the explainer chart and the AI facts use the roll year in the data', async ({ page }) => {
  const sent = await captureExplain(page);
  await dataRollYear(page, 2023);
  await gotoViewer(page);
  await selectParcelViaSearch(page);

  const panelChart = page.locator('#parcel-info-panel svg[aria-label="AV history chart"]');
  await expect(panelChart).toBeVisible();
  const panelYears = await yearLabels(panelChart);
  expect(panelYears.at(-1)).toBe(2023);
  expect(panelYears).toEqual(panelYears.map((_, i) => 2023 - (panelYears.length - 1 - i)));

  await page.locator('#parcel-info-panel .pv-info-btn[data-info="assess"]').click();
  const xpChart = page.locator('.pv-modal-backdrop svg[aria-label^="Five-year assessed value history"]');
  await expect(xpChart).toBeVisible();
  expect((await yearLabels(xpChart)).at(-1)).toBe(2023);

  await expect.poll(() => sent.length).toBeGreaterThan(0);
  const facts = findFacts(sent[0]);
  expect(facts, 'explain request carries the assessment facts').not.toBeNull();
  expect(facts.roll_year).toBe(2023);
  expect(facts.roll_year_source).toBe('data');
  expect(facts.assessed_value_by_year.at(-1).year).toBe(2023);
});

test('a county-config roll year overrides the data', async ({ page }) => {
  const sent = await captureExplain(page);
  await dataRollYear(page, 2023);
  await page.route(/\/api\/config\.js(\?|$)/, async (route) => {
    const res = await route.fetch();
    const body = (await res.text()) + '\nwindow.COUNTY.assessing = { rollYear: 2025 };';
    await route.fulfill({ response: res, body });
  });
  await gotoViewer(page);
  await selectParcelViaSearch(page);

  const panelChart = page.locator('#parcel-info-panel svg[aria-label="AV history chart"]');
  await expect(panelChart).toBeVisible();
  expect((await yearLabels(panelChart)).at(-1)).toBe(2025);

  await page.locator('#parcel-info-panel .pv-info-btn[data-info="assess"]').click();
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  const facts = findFacts(sent[0]);
  expect(facts.roll_year).toBe(2025);
  expect(facts.roll_year_source).toBe('config');
});
