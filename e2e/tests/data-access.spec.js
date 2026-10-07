// What a visitor sees past a Protected county's daily detail limit (ADR 0015, DIC-2198).
// The API's withholding is stubbed here, as the API sends it (rows flagged
// details_withheld with owner/value fields null, plus a detail_budget block), so these
// run on the normal (Open) stack; the API side is covered by api/access tests.
const { test, expect, gotoViewer, selectParcelViaSearch, ui, waitForMapIdle } = require('./fixtures');

const DETAIL_FIELDS = ['owner_name', 'owner_street', 'owner_city', 'owner_state', 'owner_zip', 'homestead',
  'assessed_value', 'taxable_value', 'prev_assessed_value', 'prev_taxable_value', 'assessed_value_yr0',
  'assessed_value_yr1', 'assessed_value_yr2', 'assessed_value_yr3', 'assessed_value_yr4',
  'legal_description', 'ps_legal_description', 'tax_description'];
const BUDGET = {
  limit: 5000, used: 5000, resets_at: '2099-01-02T00:00:00-05:00',
  data_url: 'https://example.org/county-data', terms_url: 'https://example.org/terms',
};

function withhold(props) {
  for (const f of DETAIL_FIELDS) if (f in props) props[f] = null;
  props.details_withheld = true;
}

// Rewrite real API responses: every row from `from` on is withheld.
async function stubWithheld(page, pattern, rowsOf, from = 0) {
  await page.route(pattern, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const rows = rowsOf(body);
    rows.slice(from).forEach(withhold);
    if (rows.length > from) Object.assign(body, { details_withheld: true, detail_budget: BUDGET });
    await route.fulfill({ response: res, json: body });
  });
}

const parcelProps = (b) => (b.properties ? [b.properties] : []);
const featureProps = (b) => (b.features || []).map((f) => f.properties);

test('an Open county never shows the notice', async ({ page }) => {
  await gotoViewer(page);
  await waitForMapIdle(page);
  await selectParcelViaSearch(page);

  await expect(page.getByTestId('pv-access-notice')).toHaveCount(0);
  await expect(page.getByTestId('parcel-details-withheld')).toHaveCount(0);
});

test('past the limit: one notice with the reset time and the county links, and it can be dismissed', async ({ page }) => {
  await stubWithheld(page, /\/api\/parcels\?/, featureProps, 5);
  await gotoViewer(page);
  await page.evaluate(() => window.PS_MAP.jumpTo({ center: [-85.905, 42.211], zoom: 15 }));

  const notice = page.getByTestId('pv-access-notice');
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toContainText('today’s limit for owner and value details');
  await expect(notice).toContainText('keep working');
  await expect(notice.getByRole('link', { name: 'Get the full dataset from the county' })).toHaveAttribute('href', BUDGET.data_url);
  await expect(notice.getByRole('link', { name: 'Terms of use' })).toHaveAttribute('href', BUDGET.terms_url);

  await notice.getByRole('button', { name: 'Dismiss the data limit notice' }).click();
  await expect(notice).toHaveCount(0);
  // The map still has every parcel shape.
  expect(await page.evaluate(() => window.PS_PARCEL_INDEX.length)).toBeGreaterThan(5);
});

test('the parcel panel says the details are withheld, not missing', async ({ page }) => {
  await stubWithheld(page, /\/api\/parcel\/\d+$/, parcelProps);
  await gotoViewer(page);
  await selectParcelViaSearch(page);

  await expect(ui.parcelPanel(page).getByTestId('parcel-details-withheld')).toContainText('withheld for the rest of today');
  await expect(page.getByTestId('pv-access-notice')).toBeVisible();
});

test('the tax description explainer says withheld instead of "none on record"', async ({ page }) => {
  await stubWithheld(page, /\/api\/parcel\/\d+$/, parcelProps);
  await gotoViewer(page);
  await selectParcelViaSearch(page);

  await ui.parcelPanel(page).getByRole('button', { name: 'About this tax description' }).first().click();
  const dialog = page.getByRole('dialog', { name: /^Tax Description/ });

  await expect(dialog.getByTestId('explainer-details-withheld')).toBeVisible({ timeout: 15_000 });
  await expect(dialog).not.toContainText('No tax description is on record');
});

test('compare shows "Withheld" for a withheld parcel, never $0 per acre', async ({ page }) => {
  await gotoViewer(page);
  await page.evaluate(() => window.PS_MAP.jumpTo({ center: [-85.905, 42.211], zoom: 15 }));
  await page.waitForFunction(() => (window.PS_PARCEL_INDEX || []).length > 3, null, { timeout: 15_000 });
  await stubWithheld(page, /\/api\/cohort$/, featureProps, 1);
  const ids = await page.evaluate(() => window.PS_PARCEL_INDEX.slice(0, 2).map((f) => f.id));
  await page.evaluate((ids) => window.PV_COMPARE.open(ids), ids);

  const dialog = page.getByRole('dialog', { name: 'Compare parcels' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Withheld', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByRole('cell', { name: '$0', exact: true })).toHaveCount(0);
});

test('the neighborhood profile says which figures cover which parcels', async ({ page }) => {
  await stubWithheld(page, /\/api\/cohort$/, featureProps, 3);
  await gotoViewer(page);
  await selectParcelViaSearch(page);

  await ui.parcelPanel(page).getByRole('button', { name: 'Neighborhood Profile', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Neighborhood profile' });

  const note = dialog.getByTestId('profile-details-withheld');
  await expect(note).toBeVisible({ timeout: 20_000 });
  await expect(note).toContainText(/cover 3 of \d+ parcels/);
  await expect(dialog).not.toContainText(/have no owner on record/);
});

test('About shows the data-use terms for a Protected county', async ({ page }) => {
  await gotoViewer(page);
  await page.evaluate(() => {
    const access = { mode: 'protected', termsUrl: 'https://example.org/terms', dataUrl: 'https://example.org/county-data' };
    window.COUNTY.access = access;
    if (window.PS_CONTEXT && window.PS_CONTEXT.config) window.PS_CONTEXT.config.access = access;
  });

  await ui.helpMenuButton(page).click();
  await ui.helpMenu(page).getByRole('menuitem', { name: 'About', exact: true }).click();

  const row = page.getByRole('dialog', { name: 'About' }).getByTestId('about-data-use');
  await expect(row).toContainText('limited to a daily amount');
  await expect(row.getByRole('link', { name: 'Terms of use' })).toHaveAttribute('href', 'https://example.org/terms');
});
