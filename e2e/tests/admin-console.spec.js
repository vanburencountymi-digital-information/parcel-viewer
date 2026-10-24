// Admin console (/admin/): every module renders, read-only paths work, and write paths
// without a token fail with a message rather than a crash. Nothing here writes: the local
// stack has no writer store / token, and Export (a file download) is skipped.
const { test, expect } = require('./fixtures');

const MODULES = ['county', 'intelligence', 'styling', 'data', 'access', 'manifest'];
// The nav button for each module, by its label.
const NAV = { county: 'County Configuration', intelligence: 'Intelligence', styling: 'Styling',
  data: 'Data & Layers', access: 'Access & Ops', manifest: 'Theme Manifest' };

const navItem = (page, mod) => page.getByRole('navigation', { name: 'Admin sections' }).getByRole('button', { name: NAV[mod] });
const status = (page) => page.getByRole('status', { name: 'Config status' });
const main = (page) => page.getByRole('main');
const authBox = (page) => page.getByTestId('ac-auth');
// Any editable form field (text, number, select, checkbox…).
const formField = (scope) => ['textbox', 'spinbutton', 'combobox', 'listbox', 'checkbox', 'radio', 'slider']
  .map((role) => scope.getByRole(role)).reduce((a, b) => a.or(b));

async function gotoAdmin(page, mod = 'county') {
  await page.goto('/admin/#' + mod);
  await expect(navItem(page, mod)).toHaveAttribute('aria-current', 'page');
  // Wait for the live config fetch to land (status pill flips from preview to live).
  await expect(status(page)).toHaveText(/Live config|Read-only preview/);
}

// Unauthenticated writes/history against the API are *expected* to 401/503 here.
const EXPECTED_HTTP = /Failed to load resource: the server responded with a status of (401|503)/;

test.describe('Admin console', () => {
  for (const mod of MODULES) {
    test(`${mod}: renders from the live config with no script errors`, async ({ page }) => {
      await gotoAdmin(page, mod);
      await page.waitForTimeout(1500);
      const content = main(page);
      await expect(content).not.toBeEmpty();
      expect((await content.innerText()).length).toBeGreaterThan(200);
      await expect(status(page)).toHaveText(/Live config/);
    });
  }

  test('intelligence lists the explainer plugins from Map Buddy', async ({ page }) => {
    await gotoAdmin(page, 'intelligence');
    await expect(main(page)).not.toContainText(/Couldn.t reach the Map Buddy service/, { timeout: 15_000 });
    await expect(main(page)).toContainText(/assessment/i);
  });

  for (const [mod, edit] of [['county', 'Edit configuration'], ['styling', 'Edit styling'], ['data', 'Edit layers'], ['access', 'Edit access']]) {
    test(`${mod}: Edit opens a form and Cancel discards it`, async ({ page, consoleGuard }) => {
      consoleGuard.allow(EXPECTED_HTTP);   // opening the editor asks for the server draft (no writer store here)
      await gotoAdmin(page, mod);
      const content = main(page);
      await content.getByRole('button', { name: edit }).click();
      await expect(formField(content).first()).toBeVisible();
      const cancel = content.getByRole('button', { name: /Cancel|Discard/ }).first();
      await expect(cancel).toBeVisible();
      await cancel.click();
      await expect(content.getByRole('button', { name: edit })).toBeVisible();
    });

    test(`${mod}: saving without an admin token fails with a visible message`, async ({ page, consoleGuard }) => {
      consoleGuard.allow(EXPECTED_HTTP);
      await gotoAdmin(page, mod);
      const content = main(page);
      await content.getByRole('button', { name: edit }).click();
      await content.getByRole('button', { name: /Save/ }).first().click();
      await expect(page.getByTestId('ac-flash').or(page.getByRole('alert')).or(page.getByRole('status')).filter({ hasText: /auth|token|store|not configured|fail|error|couldn/i }).first()).toBeVisible();
    });
  }

  test('version history without a token explains why it is unavailable', async ({ page, consoleGuard }) => {
    consoleGuard.allow(EXPECTED_HTTP);
    await gotoAdmin(page, 'county');
    await main(page).getByRole('button', { name: 'Version history' }).click();
    await expect(page.locator('body')).toContainText(/auth|token|store|not configured|unavailable|sign in/i);
  });

  // Layer discovery is admin-only (DIC-1872: it scans every geo table). The local stack
  // has no staff sign-in, so the console must explain that rather than fail silently.
  // Signed in, discovery itself is covered by the API tests.
  test('data: Add layer explains that discovery needs a staff sign-in', async ({ page, consoleGuard }) => {
    consoleGuard.allow(EXPECTED_HTTP);
    await gotoAdmin(page, 'data');
    await main(page).getByRole('button', { name: 'Add layer' }).click();
    await expect(main(page)).toContainText(/needs a staff sign-in/i, { timeout: 15_000 });
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
      const auth = authBox(page);
      await auth.getByLabel('Username').fill('tester');
      await auth.getByLabel('Password').fill('a-password');
      await auth.getByRole('button', { name: 'Sign in' }).click();
      await expect(auth).toContainText('Signed in as tester');
    }

    test('signing in sends the token, survives a reload, and signing out revokes it', async ({ page }) => {
      const seen = {};
      await stubSignIn(page, seen);
      await gotoAdmin(page, 'data');
      await expect(main(page)).toContainText(/staff sign-in/i);

      await signIn(page);

      expect(seen.login).toEqual({ username: 'tester', password: 'a-password' });
      // Signing in redraws the module, so discovery runs again, now with the token.
      await expect(main(page).getByRole('combobox', { name: 'PostGIS layer' })).toContainText('All available layers added');
      expect(seen.discoverAuth).toBe('Token ' + TOKEN);

      await page.reload();
      await expect(authBox(page)).toContainText('Signed in as tester');

      await authBox(page).getByRole('button', { name: 'Sign out' }).click();
      await expect(authBox(page).getByRole('button', { name: 'Sign in' })).toBeVisible();
      await expect.poll(() => seen.logoutAuth).toBe('Token ' + TOKEN);
      expect(await page.evaluate(() => sessionStorage.getItem('pv-admin-auth'))).toBeNull();
    });

    test('a refused sign-in says why and keeps the form', async ({ page, consoleGuard }) => {
      consoleGuard.allow(/status of 401/);
      await page.route('**/api/auth/login', (route) => route.fulfill({ status: 401, json: { detail: 'Invalid username or password.' } }));
      await gotoAdmin(page, 'county');
      const auth = authBox(page);
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

      await expect(authBox(page).getByRole('button', { name: 'Sign in' })).toBeVisible();
      expect(await page.evaluate(() => sessionStorage.getItem('pv-admin-auth'))).toBeNull();
    });

    test('a stored sign-in is kept when the API cannot be reached to check it', async ({ page, consoleGuard }) => {
      consoleGuard.allow(/net::ERR_FAILED/);
      await page.route('**/api/auth/me', (route) => route.abort());
      await page.addInitScript(() => sessionStorage.setItem('pv-admin-auth', JSON.stringify({ token: 'kept', username: 'offline' })));
      await gotoAdmin(page, 'county');

      await expect(authBox(page)).toContainText('Signed in as offline');
    });

    test('while signing in the button is disabled, and other refusals say why', async ({ page, consoleGuard }) => {
      consoleGuard.allow(/status of 429|net::ERR_FAILED/);
      let release;
      const held = new Promise((r) => { release = r; });
      const replies = [
        async (route) => { await held; await route.fulfill({ status: 429, json: { detail: 'Slow down.' } }); },
        (route) => route.abort(),
      ];
      await page.route('**/api/auth/login', (route) => replies.shift()(route));
      await gotoAdmin(page, 'county');
      const auth = authBox(page);
      await auth.getByLabel('Username').fill('tester');
      await auth.getByLabel('Password').fill('a-password');
      await auth.getByRole('button', { name: 'Sign in' }).click();

      await expect(auth.getByRole('button', { name: 'Sign in' })).toBeDisabled();
      await expect(auth.getByRole('status')).toHaveText('Signing in…');
      release();
      await expect(auth.getByRole('status')).toContainText(/Too many attempts/);
      await expect(auth.getByRole('button', { name: 'Sign in' })).toBeEnabled();

      await auth.getByLabel('Password').fill('a-password');
      await auth.getByRole('button', { name: 'Sign in' }).click();
      await expect(auth.getByRole('status')).toContainText(/Couldn.t sign in \(no response\)/);
    });

    test('signed in, saves send the token; a refused token signs out and says it expired', async ({ page, consoleGuard }) => {
      consoleGuard.allow(/status of (401|404)/);
      const seen = {};
      await stubSignIn(page, seen);
      await page.route('**/api/config/*/draft', async (route) => {
        if (route.request().method() === 'GET') return route.fulfill({ status: 404, json: { detail: 'No draft.' } });
        seen.saveAuth = route.request().headers().authorization;
        await route.fulfill({ status: 401, json: { detail: 'Invalid token.' } });
      });
      await gotoAdmin(page, 'county');
      await signIn(page);

      const content = main(page);
      await content.getByRole('button', { name: 'Edit configuration' }).click();
      await content.getByRole('button', { name: 'Save draft' }).click();

      await expect(page.getByTestId('ac-flash')).toContainText('Your staff sign-in has expired');
      expect(seen.saveAuth).toBe('Token ' + TOKEN);
      await expect(authBox(page).getByRole('button', { name: 'Sign in' })).toBeVisible();
      // The editor stays open, so the draft isn't lost while signing in again.
      await expect(content.getByRole('button', { name: 'Save draft' })).toBeVisible();
      expect(await page.evaluate(() => sessionStorage.getItem('pv-admin-auth'))).toBeNull();
    });
  });

  // The console shell: navigation, the top bar, and the shared draft → save → publish →
  // history flow every editable module uses. The local stack has no writable store, so the
  // store's routes are stubbed: these check what the console sends and shows.
  test.describe('shell and edit flow', () => {
    const draftField = (page, path) => main(page).locator(`[data-path="${path}"]`);

    // Stubs the config store's write routes; `seen` records what the console sent. With no
    // saved draft, opening the editor gets a 404 (as from the real store).
    async function stubStore(page, consoleGuard, seen, { draft = null, versions = [] } = {}) {
      consoleGuard.allow(/status of 404/);
      await page.route('**/api/config/*/draft', async (route) => {
        const req = route.request();
        if (req.method() === 'GET') {
          return route.fulfill(draft ? { json: draft } : { status: 404, json: { detail: 'No draft.' } });
        }
        seen.saved = req.postDataJSON();
        await route.fulfill({ json: { ok: true } });
      });
      await page.route('**/api/config/*/publish', async (route) => {
        seen.published = route.request().postDataJSON();
        await route.fulfill({ json: { version: 7 } });
      });
      await page.route('**/api/config/*/versions', (route) => route.fulfill({ json: { versions } }));
      await page.route('**/api/config/*/rollback', async (route) => {
        seen.rollback = route.request().postDataJSON();
        await route.fulfill({ json: { version: 8 } });
      });
    }

    test('the nav opens each module, marks it current and keeps it in the address', async ({ page }) => {
      await gotoAdmin(page, 'county');
      for (const mod of ['styling', 'access', 'county']) {
        await navItem(page, mod).click();
        await expect(navItem(page, mod)).toHaveAttribute('aria-current', 'page');
        await expect(page).toHaveURL(new RegExp('#' + mod + '$'));
        await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(NAV[mod]);
      }
      await expect(page.getByRole('navigation', { name: 'Admin sections' }).locator('[aria-current]')).toHaveCount(1);
      await expect(main(page)).toBeFocused();
    });

    test('an unknown address opens County Configuration', async ({ page }) => {
      await page.goto('/admin/#nope');
      await expect(navItem(page, 'county')).toHaveAttribute('aria-current', 'page');
      await expect(page).toHaveURL(/#county$/);
    });

    test('the top bar shows the live county and status; without the API, the baked fallback', async ({ page, consoleGuard }) => {
      consoleGuard.allow(/status of 503/);
      await gotoAdmin(page, 'county');
      await expect(status(page)).toHaveText('Live config · read-only');
      await expect(page.getByRole('combobox', { name: 'Active county' })).toHaveText('Van Buren County');

      await page.route('**/api/config', (route) => route.fulfill({ status: 503, json: { error: 'down' } }));
      await page.reload();
      await expect(navItem(page, 'county')).toHaveAttribute('aria-current', 'page');
      await page.waitForTimeout(1000);
      await expect(status(page)).toHaveText('Read-only preview');
      await expect(main(page)).toContainText(/not reachable — showing the baked/);
      await expect(page.getByRole('combobox', { name: 'Active county' })).toHaveText('Van Buren County');
    });

    test('switching module drops an edit in progress', async ({ page, consoleGuard }) => {
      await stubStore(page, consoleGuard, {});
      await gotoAdmin(page, 'county');
      await main(page).getByRole('button', { name: 'Edit configuration' }).click();
      await draftField(page, 'name').fill('Changed');
      await navItem(page, 'access').click();
      await navItem(page, 'county').click();
      await expect(main(page).getByRole('button', { name: 'Edit configuration' })).toBeVisible();
      await expect(main(page).getByRole('definition').first()).toHaveText('Van Buren County');
    });

    test('Edit continues a saved server draft', async ({ page, consoleGuard }) => {
      await stubStore(page, consoleGuard, {}, { draft: { name: 'Drafted County', state: 'MI' } });
      await gotoAdmin(page, 'county');
      await main(page).getByRole('button', { name: 'Edit configuration' }).click();
      await expect(draftField(page, 'name')).toHaveValue('Drafted County');
    });

    test('Save draft sends the edited config; typed fields keep their types', async ({ page, consoleGuard }) => {
      const seen = {};
      await stubStore(page, consoleGuard, seen);
      await gotoAdmin(page, 'county');
      await main(page).getByRole('button', { name: 'Edit configuration' }).click();
      await draftField(page, 'name').fill('Renamed County');
      await draftField(page, 'map.zoom').fill('11');
      await draftField(page, 'map.center').fill('[-86, 42.3]');
      await draftField(page, 'map.extent').fill('[not json');   // ignored, and marked
      await expect(draftField(page, 'map.extent')).toHaveClass(/ac-input-err/);
      await main(page).getByRole('button', { name: 'Save draft' }).click();

      await expect(page.getByTestId('ac-flash')).toHaveText('Draft saved.');
      expect(seen.saved.author).toBe('console');
      expect(seen.saved.payload).toMatchObject({ name: 'Renamed County', map: { zoom: 11, center: [-86, 42.3] } });
      expect(Array.isArray(seen.saved.payload.map.extent)).toBe(true);
    });

    test('rows can be added to and removed from a list', async ({ page, consoleGuard }) => {
      const seen = {};
      await stubStore(page, consoleGuard, seen);
      await gotoAdmin(page, 'county');
      const content = main(page);
      await content.getByRole('button', { name: 'Edit configuration' }).click();
      const rows = content.locator('[data-path$=".description"][data-path^="parcelNumber.segments."]');
      const before = await rows.count();
      await content.getByRole('button', { name: '+ Add segment' }).click();
      await expect(rows).toHaveCount(before + 1);
      await draftField(page, `parcelNumber.segments.${before}.name`).fill('Check digit');
      await content.locator('[data-remove="parcelNumber.segments"][data-index="0"]').click();
      await expect(rows).toHaveCount(before);
      await content.getByRole('button', { name: 'Save draft' }).click();
      await expect(page.getByTestId('ac-flash')).toHaveText('Draft saved.');
      const segs = seen.saved.payload.parcelNumber.segments;
      expect(segs).toHaveLength(before);
      expect(segs[before - 1]).toEqual({ name: 'Check digit', description: '' });
    });

    test('Publish saves the draft, publishes it, and returns to the live view', async ({ page, consoleGuard }) => {
      const seen = {};
      await stubStore(page, consoleGuard, seen);
      await gotoAdmin(page, 'access');
      const content = main(page);
      await content.getByRole('button', { name: 'Edit access' }).click();
      await draftField(page, 'access.reportTo').fill('gis@example.test');
      await content.getByRole('button', { name: 'Publish' }).click();

      await expect(page.getByTestId('ac-flash')).toHaveText('Published version 7.');
      expect(seen.saved.payload.access.reportTo).toBe('gis@example.test');
      expect(seen.published).toEqual({ author: 'console', note: 'Published from console' });
      await expect(content.getByRole('button', { name: 'Edit access' })).toBeVisible();
    });

    test('refused writes say why: not provisioned, not allowed', async ({ page, consoleGuard }) => {
      consoleGuard.allow(/status of (403|404|503)/);
      const replies = [{ status: 503, json: {} }, { status: 403, json: { detail: 'no access to vanburen' } }];
      await page.route('**/api/config/*/draft', (route) => (route.request().method() === 'GET'
        ? route.fulfill({ status: 404, json: {} }) : route.fulfill(replies.shift())));
      await gotoAdmin(page, 'county');
      await main(page).getByRole('button', { name: 'Edit configuration' }).click();
      await main(page).getByRole('button', { name: 'Save draft' }).click();
      await expect(page.getByTestId('ac-flash')).toContainText('not yet provisioned');
      await main(page).getByRole('button', { name: 'Save draft' }).click();
      await expect(page.getByTestId('ac-flash')).toHaveText('Not allowed: no access to vanburen');
    });

    test('Version history lists versions, and Restore rolls back', async ({ page, consoleGuard }) => {
      const seen = {};
      await stubStore(page, consoleGuard, seen, { versions: [
        { version: 3, note: 'Spring roll', created_by: 'jerry', created_at: '2026-04-01T09:30:00Z' },
        { version: 2, note: '', created_by: 'console', created_at: '2026-03-01T08:00:00Z' },
      ] });
      await gotoAdmin(page, 'county');
      await main(page).getByRole('button', { name: 'Version history' }).click();
      const table = main(page).getByRole('table').last();
      await expect(table).toContainText('Spring roll');
      await expect(table).toContainText('2026-04-01 09:30:00');
      await expect(main(page)).toContainText('2 published version(s)');

      await table.getByRole('button', { name: 'Restore' }).first().click();
      await expect(page.getByTestId('ac-flash')).toHaveText('Restored v3 as version 8.');
      expect(seen.rollback).toEqual({ version: 3, author: 'console' });
    });

    test('Preview hands the draft to the viewer; Cancel clears it', async ({ page, consoleGuard }) => {
      await stubStore(page, consoleGuard, {});
      await gotoAdmin(page, 'county');
      const content = main(page);
      await content.getByRole('button', { name: 'Edit configuration' }).click();
      await draftField(page, 'name').fill('Preview County');
      const popup = page.waitForEvent('popup');
      await content.getByRole('button', { name: 'Preview in viewer' }).click();
      const viewer = await popup;
      expect(new URL(viewer.url()).pathname).toBe('/demo/');
      await viewer.close();
      await expect(page.getByTestId('ac-flash')).toContainText('Draft sent to the viewer preview');
      const sent = await page.evaluate(() => JSON.parse(localStorage.getItem('pv-config-preview')));
      expect(sent.name).toBe('Preview County');

      await content.getByRole('button', { name: 'Cancel' }).click();
      expect(await page.evaluate(() => localStorage.getItem('pv-config-preview'))).toBeNull();
    });
  });

  test('manifest: Validate reports a result', async ({ page }) => {
    await gotoAdmin(page, 'manifest');
    await main(page).getByRole('button', { name: 'Validate' }).click();
    await expect(main(page)).toContainText(/valid|error|warning/i);
  });

  test('manifest: Publish without a token does not claim success', async ({ page, consoleGuard }) => {
    consoleGuard.allow(EXPECTED_HTTP);
    page.on('dialog', (d) => d.accept());   // a confirm() before publishing, if any
    await gotoAdmin(page, 'manifest');
    await main(page).getByRole('button', { name: 'Publish' }).click();
    await page.waitForTimeout(1500);
    await expect(page.locator('body')).not.toContainText(/Published v\d|published successfully/i);
  });
});
