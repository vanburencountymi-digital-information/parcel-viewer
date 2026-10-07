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

  // Staff sign-in (DIC-2151). The local stack has no staff account, so the sign-in routes
  // are stubbed: these check what the console does with them, the API tests cover the rest.
  test.describe('staff sign-in', () => {
    const TOKEN = 'stub-token-123';

    async function stubSignIn(page, seen) {
      await page.route('**/api/auth/login', async (route) => {
        seen.login = route.request().postDataJSON();
        await route.fulfill({ json: { token: TOKEN, user: { username: 'tester' }, expiry: '2099-01-01T00:00:00+00:00' } });
      });
      await page.route('**/api/auth/me', (route) => route.fulfill(
        route.request().headers().authorization === 'Token ' + TOKEN
          ? { json: { user: { username: 'tester', is_staff: true }, expiry: '2099-01-01T00:00:00+00:00' } }
          : { status: 401, json: { detail: 'Invalid token.' } }));
      await page.route('**/api/auth/logout', async (route) => {
        seen.logoutAuth = route.request().headers().authorization;
        await route.fulfill({ json: { ok: true } });
      });
      await page.route('**/api/admin/discover/layers*', async (route) => {
        seen.discoverAuth = route.request().headers().authorization;
        await route.fulfill({ json: { layers: [] } });
      });
    }

    async function signIn(page) {
      const auth = page.locator('#ac-auth');
      await auth.getByLabel('Username').fill('tester');
      await auth.getByLabel('Password').fill('a-password');
      await auth.getByRole('button', { name: 'Sign in' }).click();
      await expect(auth).toContainText('Signed in as tester');
    }

    test('signing in sends the token, survives a reload, and signing out revokes it', async ({ page }) => {
      const seen = {};
      await stubSignIn(page, seen);
      await gotoAdmin(page, 'data');
      await expect(page.locator('#ac-content')).toContainText(/staff sign-in/i);

      await signIn(page);

      expect(seen.login).toEqual({ username: 'tester', password: 'a-password' });
      // Signing in redraws the module, so discovery runs again, now with the token.
      await expect(page.locator('#ac-pg-pick')).toContainText('All available layers added');
      expect(seen.discoverAuth).toBe('Token ' + TOKEN);

      await page.reload();
      await expect(page.locator('#ac-auth')).toContainText('Signed in as tester');

      await page.locator('#ac-auth').getByRole('button', { name: 'Sign out' }).click();
      await expect(page.locator('#ac-auth').getByRole('button', { name: 'Sign in' })).toBeVisible();
      await expect.poll(() => seen.logoutAuth).toBe('Token ' + TOKEN);
      expect(await page.evaluate(() => sessionStorage.getItem('pv-admin-auth'))).toBeNull();
    });

    test('a refused sign-in says why and keeps the form', async ({ page, consoleGuard }) => {
      consoleGuard.allow(/status of 401/);
      await page.route('**/api/auth/login', (route) => route.fulfill({ status: 401, json: { detail: 'Invalid username or password.' } }));
      await gotoAdmin(page, 'county');
      const auth = page.locator('#ac-auth');
      await auth.getByLabel('Username').fill('tester');
      await auth.getByLabel('Password').fill('wrong');
      await auth.getByRole('button', { name: 'Sign in' }).click();

      await expect(auth.getByRole('status')).toContainText(/Wrong username or password/);
      await expect(auth.getByLabel('Password')).toHaveValue('');
    });

    test('an expired stored sign-in is dropped on load', async ({ page, consoleGuard }) => {
      consoleGuard.allow(/status of 401/);
      await stubSignIn(page, {});
      await page.addInitScript(() => sessionStorage.setItem('pv-admin-auth', JSON.stringify({ token: 'expired', username: 'old' })));
      await gotoAdmin(page, 'county');

      await expect(page.locator('#ac-auth').getByRole('button', { name: 'Sign in' })).toBeVisible();
      expect(await page.evaluate(() => sessionStorage.getItem('pv-admin-auth'))).toBeNull();
    });
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
