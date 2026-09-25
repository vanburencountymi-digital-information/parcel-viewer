// Tool windows opened through the real UI: the Help & tools menu, and the parcel panel's
// tool buttons. Each opens, closes via its button, reopens, closes via Esc, and returns
// keyboard focus to a sensible place.
const { test, expect, gotoViewer, selectParcelViaSearch } = require('./fixtures');

// print opens the browser's print dialog, which blocks the page; covered manually.
const MENU_TOOLS = ['share', 'bookmark', 'data-request', 'report-error', 'help', 'whats-new', 'about', 'settings'];

async function openMenuTool(page, tool) {
  await page.locator('#pv-admin-btn').click();
  const item = page.locator(`#pv-admin-menu [data-tool="${tool}"]`);
  await expect(item).toBeVisible();
  await item.click();
}

test.describe('Help & tools menu', () => {
  test.beforeEach(async ({ page }) => { await gotoViewer(page); });

  for (const tool of MENU_TOOLS) {
    test(`${tool}: opens, closes by button and by Esc`, async ({ page }) => {
      const modal = page.locator('.pv-modal-backdrop');
      await openMenuTool(page, tool);
      await expect(modal).toBeVisible();
      await expect(modal.locator('[role="dialog"], .pv-modal').first()).toBeVisible();
      const close = modal.locator('[data-close], .pv-modal-close, [aria-label*="lose" i]').filter({ visible: true }).first();
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

  test('menu closes on Escape and outside click', async ({ page }) => {
    const menu = page.locator('#pv-admin-menu');
    await page.locator('#pv-admin-btn').click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await page.locator('#pv-admin-btn').click();
    await expect(menu).toBeVisible();
    await page.mouse.click(700, 500);
    await expect(menu).toBeHidden();
  });
});

test.describe('Parcel panel tools', () => {
  test.beforeEach(async ({ page }) => { await gotoViewer(page); await selectParcelViaSearch(page); });

  for (const [label, selector, surface] of [
    ['Assessment explainer', '.pv-info-btn[data-info="assess"]', '.pv-modal-backdrop'],
    ['Tax description explainer', '.pv-info-btn[data-info="tax"]', '.pv-modal-backdrop'],
    ['Parcel packet', '.pv-ptool[data-ptool="packet"]', '.pv-modal-backdrop'],
    ['Neighborhood profile', '.pv-ptool[data-ptool="profile"]', '.pv-profile-overlay'],
  ]) {
    test(`${label}: opens and closes`, async ({ page }) => {
      await page.locator(selector).first().click();
      const el = page.locator(surface);
      await expect(el).toBeVisible();
      await page.waitForTimeout(1500);   // let async content (AI narration, cohort fetch) settle
      await page.keyboard.press('Escape');
      await expect(el).toBeHidden();
    });
  }

  test('Compare: adding the selected parcel shows it in the tray', async ({ page }) => {
    await page.locator('.pv-ptool[data-ptool="compare"]').first().click();
    await expect(page.locator('.pv-compare-tray, .pv-compare-chip, .pv-compare-overlay').first()).toBeVisible();
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
    await expect(page.locator('#mb-input')).toBeVisible();
  });
});
