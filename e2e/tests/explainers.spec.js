// Assessment / tax-description explainers in each AI state, plus the Sources panel.
// The Map Buddy service is mocked, so these cost nothing and don't depend on the model:
//   AI off (user choice)   → recorded figures + statute links, "walkthrough is off", no AI call
//   AI on, service fails    → the same facts, but says it "couldn't be reached" (not "off")
//   AI on, service answers  → narration over the same figures
const { test, expect, gotoViewer, selectParcelViaSearch, ui } = require('./fixtures');

const EXPLAIN = /\/explain(\?|$)/;
const HEALTH = /\/health(\?|$)/;

async function setup(page, aiMode, explainHandler) {
  await page.addInitScript((m) => { try { localStorage.setItem('pv-ai-mode', m); } catch (_) {} }, aiMode);
  await page.route(HEALTH, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  let calls = 0;
  await page.route(EXPLAIN, (r) => { calls++; return explainHandler ? explainHandler(r) : r.abort(); });
  await gotoViewer(page);
  await selectParcelViaSearch(page);
  return () => calls;
}
const openAssessment = (page) => ui.parcelPanel(page).getByRole('button', { name: 'About property assessment' }).click();
// The explainer dialog, named by its title ("Property Assessment — <pin>", "Tax Description — <pin>").
const modal = (page) => page.getByRole('dialog', { name: /^(Property Assessment|Tax Description)\b/ });
// The recorded-figures table of the assessment explainer.
const figures = (m) => m.getByRole('group', { name: 'Recorded figures' }).getByRole('table');

test('AI off: figures + statute links, says it is off, never calls the AI', async ({ page }) => {
  const calls = await setup(page, 'off');
  await openAssessment(page);
  await expect(figures(modal(page))).toContainText('Assessed Value (AV)');
  await expect(modal(page)).toContainText('Michigan law');
  await expect(modal(page)).toContainText('walkthrough is off');
  expect(calls()).toBe(0);
});

test('AI on but the service fails: same facts, says it could not be reached', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/Failed to load resource.*explain/);
  const calls = await setup(page, 'on', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"down"}' }));
  await openAssessment(page);
  await expect(figures(modal(page))).toContainText('Assessed Value (AV)');
  await expect(modal(page)).toContainText('couldn’t be reached');
  await expect(modal(page)).not.toContainText('walkthrough is off');
  expect(calls()).toBe(1);
});

test('AI on: narration shows over the same recorded figures', async ({ page }) => {
  await setup(page, 'on', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, explanation: {
      summary: 'MOCK SUMMARY <b>not bold</b>', sections: [{ heading: 'What it means', body: 'Body.' }],
      glossary: [], statutes: [], disclaimer: 'Educational only.' } }),
  }));
  await openAssessment(page);
  const m = modal(page);
  await expect(m).toContainText('MOCK SUMMARY <b>not bold</b>');     // model text is escaped
  await expect(m.getByTestId('pv-xp-summary').locator('b')).toHaveCount(0);
  await expect(figures(m)).toContainText('Assessed Value (AV)');
  const figsOn = await figures(m).innerText();
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.PV_PREFS.setAiMode('off'));
  await openAssessment(page);
  await expect(m).toContainText('walkthrough is off');
  expect(await figures(m).innerText(), 'identical figures with AI on and off').toBe(figsOn);
});

test('a statute citation opens the Sources panel on that statute', async ({ page }) => {
  await setup(page, 'off');
  await openAssessment(page);
  const cite = modal(page).getByTestId('cite-trigger').first();
  const name = (await cite.innerText()).trim();
  await cite.click();
  // The explainer closes so the panel is reachable: in the accessibility tree, not inert,
  // and focused (DIC-2182). It used to stay behind the dialog's inert + aria-hidden page.
  const panel = page.getByRole('region', { name: 'Sources' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(name.slice(0, 20));
  await expect(modal(page)).toBeHidden();
  await expect(panel).toBeFocused();
  await expect(page.locator('#app')).not.toHaveAttribute('inert');
});

test('tax description explainer renders in AI-off mode', async ({ page }) => {
  await setup(page, 'off');
  await ui.parcelPanel(page).getByRole('button', { name: 'About this tax description' }).click();
  await expect(modal(page).getByRole('group', { name: 'Recorded tax description' })).toContainText('Tax description');
  await expect(modal(page).getByTestId('pv-xp-desc')).toBeVisible();
});

test('the assessment explainer charts five years of assessed value', async ({ page }) => {
  await setup(page, 'off');
  await openAssessment(page);
  await expect(modal(page).getByRole('img', { name: 'Five-year assessed value history, oldest to newest' })).toBeVisible();
});

test('Print and Download HTML produce the explainer document', async ({ page }) => {
  await setup(page, 'off');
  const pin = await page.evaluate(() => {
    window.__printed = [];
    window.PV_DOC.print = (html) => { window.__printed.push(html); };
    return window.PS_STATE.parcel.pin;
  });
  await openAssessment(page);
  const m = modal(page);
  await expect(figures(m)).toContainText('Assessed Value (AV)');
  await m.getByRole('button', { name: 'Print', exact: true }).click();
  const printed = await page.evaluate(() => window.__printed);
  expect(printed).toHaveLength(1);
  expect(printed[0]).toContain(`<h1>Parcel ${pin}</h1>`);
  expect(printed[0]).toContain('Michigan law');
  const download = page.waitForEvent('download');
  await m.getByRole('button', { name: 'Download HTML', exact: true }).click();
  expect((await download).suggestedFilename()).toBe(`assessment-${pin.replace(/[^\w.-]/g, '_')}.html`);
});

test('a parcel record that fails to load says so', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/status of 500 .*\/api\/parcel\/\d+/);
  await setup(page, 'off');
  await page.route(/\/api\/parcel\/\d+(\?|$)/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await openAssessment(page);
  await expect(modal(page)).toContainText('Couldn’t load this parcel’s property assessment.');
  await expect(modal(page)).toContainText('HTTP 500');
});

test('the tax description breaks the parcel number into its parts', async ({ page }) => {
  await setup(page, 'off');
  const pin = await page.evaluate(() => window.PS_STATE.parcel.pin);
  await ui.parcelPanel(page).getByRole('button', { name: 'About this tax description' }).click();
  const parts = modal(page).getByRole('group', { name: 'Recorded tax description' }).getByRole('listitem');
  await expect(parts).toHaveCount(pin.split('-').length);
  await expect(parts.first()).toContainText(pin.split('-')[0]);
});

// No button opens the live ledger yet; PV_WINDOWS can.
test('the live Parcel Ledger lists the recorded events, or says there are none', async ({ page }) => {
  await setup(page, 'off');
  const pin = await page.evaluate(() => { window.PV_WINDOWS.open('ledger'); return window.PS_STATE.parcel.pin; });
  const ledger = page.getByRole('dialog', { name: `Parcel Ledger — ${pin}` });
  await expect(ledger.getByText(/^(Every event the county has recorded for this parcel|No recorded events for this parcel yet)/)).toBeVisible();
});

test('with no parcel selected, the info windows give the general overview', async ({ page }) => {
  await gotoViewer(page);
  await page.evaluate(() => { window.PV_TOOLS.open('assess'); });
  const assess = page.getByRole('dialog', { name: 'About Property Assessment' });
  await expect(assess).toContainText('Taxable Value (TV)');
  await expect(assess).toContainText('Assessment Explainer');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.PV_TOOLS.open('tax'); });
  const tax = page.getByRole('dialog', { name: 'About the Tax Description' });
  await expect(tax).toContainText('for taxation purposes only');
});
