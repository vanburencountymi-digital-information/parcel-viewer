// Admin console (/admin/): every module renders, read-only paths work, and write paths
// without a token fail with a message rather than a crash. Nothing here writes: the local
// stack has no writer store / token, and Export (a file download) is skipped.
const { test, expect } = require('./fixtures');

const MODULES = ['county', 'intelligence', 'styling', 'data', 'access', 'manifest'];

async function gotoAdmin(page, mod = 'county') {
  await page.goto('/admin/#' + mod);
  await expect(page.locator(`.ac-nav-item[data-mod="${mod}"]`)).toHaveClass(/is-active/);
  // Wait for the live config fetch to land (status pill flips from preview to live).
  await expect(page.locator('#ac-status')).toHaveText(/Live config|Read-only preview/);
}

// Unauthenticated writes/history against the API are *expected* to 401/503 here.
const EXPECTED_HTTP = /Failed to load resource: the server responded with a status of (401|503)/;

test.describe('Admin console', () => {
  for (const mod of MODULES) {
    test(`${mod}: renders from the live config with no script errors`, async ({ page }) => {
      await gotoAdmin(page, mod);
      await page.waitForTimeout(1500);
      const content = page.locator('#ac-content');
      await expect(content).not.toBeEmpty();
      expect((await content.innerText()).length).toBeGreaterThan(200);
      await expect(page.locator('#ac-status')).toHaveText(/Live config/);
    });
  }

  test('intelligence lists the explainer plugins from Map Buddy', async ({ page }) => {
    await gotoAdmin(page, 'intelligence');
    await expect(page.locator('#ac-content')).not.toContainText(/Couldn.t reach the Map Buddy service/, { timeout: 15_000 });
    await expect(page.locator('#ac-content')).toContainText(/assessment/i);
  });

  for (const [mod, edit] of [['county', 'Edit configuration'], ['styling', 'Edit styling'], ['data', 'Edit layers'], ['access', 'Edit access']]) {
    test(`${mod}: Edit opens a form and Cancel discards it`, async ({ page, consoleGuard }) => {
      consoleGuard.allow(EXPECTED_HTTP);   // opening the editor asks for the server draft (no writer store here)
      await gotoAdmin(page, mod);
      const content = page.locator('#ac-content');
      await content.getByRole('button', { name: edit }).click();
      await expect(content.locator('input, select, textarea').first()).toBeVisible();
      const cancel = content.getByRole('button', { name: /Cancel|Discard/ }).first();
      await expect(cancel).toBeVisible();
      await cancel.click();
      await expect(content.getByRole('button', { name: edit })).toBeVisible();
    });

    test(`${mod}: saving without an admin token fails with a visible message`, async ({ page, consoleGuard }) => {
      consoleGuard.allow(EXPECTED_HTTP);
      await gotoAdmin(page, mod);
      const content = page.locator('#ac-content');
      await content.getByRole('button', { name: edit }).click();
      await content.getByRole('button', { name: /Save/ }).first().click();
      await expect(page.locator('#ac-flash, .ac-flash, [role="alert"], [role="status"]').filter({ hasText: /auth|token|store|not configured|fail|error|couldn/i }).first()).toBeVisible();
    });
  }

  test('version history without a token explains why it is unavailable', async ({ page, consoleGuard }) => {
    consoleGuard.allow(EXPECTED_HTTP);
    await gotoAdmin(page, 'county');
    await page.locator('#ac-content').getByRole('button', { name: 'Version history' }).click();
    await expect(page.locator('body')).toContainText(/auth|token|store|not configured|unavailable|sign in/i);
  });

  // Layer discovery is admin-only (DIC-1872: it scans every geo table). The local stack
  // has no admin token, so the console must explain that rather than fail silently.
  // With a token, discovery itself is covered by the API tests.
  test('data: Add layer explains that discovery needs the admin token', async ({ page, consoleGuard }) => {
    consoleGuard.allow(EXPECTED_HTTP);
    await gotoAdmin(page, 'data');
    await page.locator('#ac-content').getByRole('button', { name: 'Add layer' }).click();
    await expect(page.locator('#ac-content')).toContainText(/admin token/i, { timeout: 15_000 });
  });

  test('manifest: Validate reports a result', async ({ page }) => {
    await gotoAdmin(page, 'manifest');
    await page.locator('#ac-content').getByRole('button', { name: 'Validate' }).click();
    await expect(page.locator('#ac-content')).toContainText(/valid|error|warning/i);
  });

  test('manifest: Publish without a token does not claim success', async ({ page, consoleGuard }) => {
    consoleGuard.allow(EXPECTED_HTTP);
    page.on('dialog', (d) => d.accept());   // a confirm() before publishing, if any
    await gotoAdmin(page, 'manifest');
    await page.locator('#ac-content').getByRole('button', { name: 'Publish' }).click();
    await page.waitForTimeout(1500);
    await expect(page.locator('body')).not.toContainText(/Published v\d|published successfully/i);
  });
});
