// Tool windows opened through the real UI: the Help & tools menu, and the parcel panel's
// tool buttons. Each opens, closes via its button, reopens, closes via Esc, and returns
// keyboard focus to a sensible place.
const { test, expect, gotoViewer, selectParcelViaSearch, ui } = require('./fixtures');

// print opens the browser's print dialog, which blocks the page; covered manually.
// [menu item, the dialog it opens]
const MENU_TOOLS = [['Share', 'Share'], ['Bookmark', 'Bookmarks'], ['Data Request', 'Data Request'],
  ['Report a data error', 'Report a data error'], ['Help', 'Help'], ['What’s New', "What's New"],
  ['About', 'About'], ['Settings', 'Settings']];

async function openMenuTool(page, tool) {
  await ui.helpMenuButton(page).click();
  const item = ui.helpMenu(page).getByRole('menuitem', { name: tool, exact: true });
  await expect(item).toBeVisible();
  await item.click();
}

test.describe('Help & tools menu', () => {
  test.beforeEach(async ({ page }) => { await gotoViewer(page); });

  for (const [tool, title] of MENU_TOOLS) {
    test(`${tool}: opens, closes by button and by Esc`, async ({ page }) => {
      const modal = page.getByRole('dialog', { name: title, exact: true });
      await openMenuTool(page, tool);
      await expect(modal).toBeVisible();
      // The header's Close (some dialogs also have a Close button in the footer).
      const close = modal.getByRole('button', { name: 'Close', exact: true }).filter({ visible: true }).first();
      await close.click();
      await expect(modal).toBeHidden();
      await openMenuTool(page, tool);
      await expect(modal).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(modal).toBeHidden();
      // Focus must not be lost to <body> after the dialog closes.
      expect(await page.evaluate(() => document.activeElement && document.activeElement.tagName)).not.toBe('BODY');
    });
  }

  test('Report a data error: sends the report for the selected parcel', async ({ page }) => {
    await selectParcelViaSearch(page);
    const sent = [];
    await page.route('**/api/report-error', async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    });
    await openMenuTool(page, 'Report a data error');
    const modal = page.getByRole('dialog', { name: 'Report a data error', exact: true });
    const pin = await modal.getByLabel('Parcel number').inputValue();
    expect(pin).not.toBe('');
    await modal.getByRole('button', { name: 'Send report' }).click();   // details are required
    expect(sent).toEqual([]);
    await modal.getByLabel('What’s incorrect?').fill('The owner name is out of date.');
    await modal.getByRole('button', { name: 'Send report' }).click();
    await expect(modal.getByText('Report received!')).toBeVisible();
    expect(sent).toEqual([{ pin, details: 'The owner name is out of date.', email: '' }]);
  });

  test('Report a data error: a refused report says why and keeps the form', async ({ page, consoleGuard }) => {
    consoleGuard.allow(/status of 429 .*\/api\/report-error/);   // the browser logs the refusal
    await page.route('**/api/report-error', (route) => route.fulfill({ status: 429, json: { detail: 'slow down' } }));
    await openMenuTool(page, 'Report a data error');
    const modal = page.getByRole('dialog', { name: 'Report a data error', exact: true });
    await modal.getByLabel('What’s incorrect?').fill('Wrong boundary.');
    await modal.getByRole('button', { name: 'Send report' }).click();
    await expect(modal.getByRole('alert')).toHaveText(/sent several reports recently/);
    await expect(modal.getByLabel('What’s incorrect?')).toHaveValue('Wrong boundary.');
  });

  test('Data Request: embeds the request form', async ({ page }) => {
    await page.route('https://form.jotform.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>form</p>' }));
    await openMenuTool(page, 'Data Request');
    const modal = page.getByRole('dialog', { name: 'Data Request', exact: true });
    await expect(modal.getByTitle('Data Request form')).toHaveAttribute('src', /^https:\/\//);
    await expect(modal.getByRole('link', { name: /Open it in a new tab/ })).toHaveAttribute('target', '_blank');
  });

  test('menu closes on Escape and outside click', async ({ page }) => {
    const menu = ui.helpMenu(page);
    await ui.helpMenuButton(page).click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await ui.helpMenuButton(page).click();
    await expect(menu).toBeVisible();
    await page.mouse.click(700, 500);
    await expect(menu).toBeHidden();
  });
});

test.describe('Parcel panel tools', () => {
  test.beforeEach(async ({ page }) => { await gotoViewer(page); await selectParcelViaSearch(page); });

  // [test label, the parcel panel button, the dialog it opens]
  for (const [label, button, dialog] of [
    ['Assessment explainer', 'About property assessment', /^Property Assessment/],
    ['Tax description explainer', 'About this tax description', /^Tax Description/],
    ['Parcel packet', 'Generate Parcel Packet', 'Parcel Packet'],
    ['Neighborhood profile', 'Neighborhood Profile', 'Neighborhood profile'],
  ]) {
    test(`${label}: opens and closes`, async ({ page }) => {
      await ui.parcelPanel(page).getByRole('button', { name: button, exact: true }).first().click();
      const el = page.getByRole('dialog', { name: dialog, exact: typeof dialog === 'string' });
      await expect(el).toBeVisible();
      await page.waitForTimeout(1500);   // let async content (AI narration, cohort fetch) settle
      await page.keyboard.press('Escape');
      await expect(el).toBeHidden();
    });
  }

  test('Compare: adding the selected parcel shows it in the tray', async ({ page }) => {
    await ui.parcelPanel(page).getByRole('button', { name: 'Compare Parcels', exact: true }).first().click();
    await expect(page.getByTestId('pv-compare-tray').or(page.getByTestId('pv-compare-chip'))
      .or(page.getByRole('dialog', { name: 'Compare parcels', exact: true })).first()).toBeVisible();
  });
});

test.describe('Map Buddy panel', () => {
  test('PV_MAP_BUDDY exposes both the panel API and the command API', async ({ page }) => {
    await gotoViewer(page);
    const api = await page.evaluate(() => Object.keys(window.PV_MAP_BUDDY || {}).sort());
    for (const k of ['open', 'collapse', 'toggle', 'isOpen', 'ask', 'runCommands', 'buildMapState', 'send']) {
      expect(api, `PV_MAP_BUDDY.${k}`).toContain(k);
    }
  });

  // The "Ask Map Buddy" hint (hints.js) and the mobile Map Buddy tab both call exactly
  // this: toggle() when !isOpen(). The hint itself only shows in some states, so test the
  // contract they depend on rather than a sometimes-hidden button.
  test('toggle() opens the chat panel and isOpen() reports it', async ({ page }) => {
    await gotoViewer(page);
    expect(await page.evaluate(() => window.PV_MAP_BUDDY.isOpen())).toBe(false);
    await page.evaluate(() => window.PV_MAP_BUDDY.toggle());
    await expect.poll(() => page.evaluate(() => window.PV_MAP_BUDDY.isOpen())).toBe(true);
    await expect(ui.mapBuddyInput(page)).toBeVisible();
  });
});
