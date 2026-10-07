// Search box -> results -> parcel info panel, driven through the real UI.
const { test, expect, gotoViewer, selectParcelViaSearch, selectedPin, ui } = require('./fixtures');

const results = (page) => ui.searchResults(page).getByRole('option');
// Every result row in the DOM, shown or not (a hidden stale list still counts).
const anyResults = (page) => page.getByRole('listbox', { name: 'Parcel search results', includeHidden: true })
  .getByRole('option', { includeHidden: true });

test.beforeEach(async ({ page }) => { await gotoViewer(page); });

test('search shows results and selecting one opens the parcel panel', async ({ page }) => {
  const pin = await selectParcelViaSearch(page, 'paw paw');
  const panel = ui.parcelPanel(page);
  for (const section of ['Parcel', 'Owner', 'Assessed Values', 'Tax Description']) {
    // A title may hold an info button, so its name can run on ("Assessed Values About property assessment").
    await expect(panel.getByRole('heading', { level: 3, name: new RegExp('^' + section) }).first()).toBeVisible();
  }
  expect(await selectedPin(page)).toBe(pin);
});

test('keyboard: arrow down + Enter selects a result; Escape closes the list', async ({ page }) => {
  const input = ui.searchInput(page);
  await input.fill('paw paw');
  await expect(results(page).first()).toBeVisible();
  await input.press('ArrowDown');
  await expect(ui.searchResults(page).getByRole('option', { selected: true })).toHaveCount(1);
  await input.press('Enter');
  await expect(ui.parcelPanel(page)).toBeVisible();
  await input.fill('paw paw');
  await expect(results(page).first()).toBeVisible();
  await input.press('Escape');
  await expect(ui.searchResults(page)).toBeHidden();
});

test('search with no matches says so', async ({ page }) => {
  await ui.searchInput(page).fill('zzqqxxnomatch');
  await expect(page.getByTestId('parcel-search-no-results')).toHaveText(/No matches/);
});

test('clearing the query below 2 chars does not bring stale results back', async ({ page }) => {
  const input = ui.searchInput(page);
  await input.fill('paw');
  await input.press('Backspace');
  await input.press('Backspace');           // "p" — below the 2-char minimum
  await page.waitForTimeout(1500);          // longer than the debounce + a search round-trip
  await expect(anyResults(page)).toHaveCount(0);
});

test('the panel close button clears the selection', async ({ page }) => {
  await selectParcelViaSearch(page);
  const panel = ui.parcelPanel(page);
  await panel.getByRole('button', { name: 'Clear selection' }).click();
  await expect(panel).toBeHidden();
  expect(await selectedPin(page)).toBeNull();
});

test('Escape inside a dialog closes the dialog but keeps the parcel selected', async ({ page }) => {
  const pin = await selectParcelViaSearch(page);
  await ui.parcelPanel(page).getByRole('button', { name: 'About property assessment' }).first().click();
  const modal = page.getByRole('dialog', { name: /Property Assessment/ });
  await expect(modal).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  expect(await selectedPin(page)).toBe(pin);
  await expect(ui.parcelPanel(page)).toBeVisible();
});
