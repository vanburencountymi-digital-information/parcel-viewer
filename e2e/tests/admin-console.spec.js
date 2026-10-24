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
// The value next to a row's label (a <dt> / <dd> pair), and a module's card by its title.
const dd = (scope, label) => scope.locator('dt', { hasText: new RegExp('^' + label + '$') }).locator('xpath=following-sibling::dd[1]');
const card = (page, title) => main(page).locator('.ac-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

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

  // Intelligence (DIC-459): the explainer plugins, from a stubbed Map Buddy /explainers so
  // the content is fixed (the test above reads the real service).
  test.describe('intelligence (stubbed explainers)', () => {
    const EXPLAINERS = [
      { id: 'assessment', label: 'Assessment Explainer', model: 'claude-test-1', audience: 'Residents',
        callable_via: 'POST /explain (topic: assessment)', system_prompt: 'Explain <b>plainly</b>.',
        context_blocks: [{ title: 'Statutes', body: 'MCL 211.27a', chars: 11 }, { title: 'Glossary', body: 'SEV = state equalized value', chars: 27 }] },
      { id: 'tax', label: 'Tax Description', model: '', system_prompt: '' },
    ];
    const stub = (page, reply) => page.route('**/explainers', (route) => route.fulfill(reply));

    test('a card per plugin: its id, audience, model and how to call it', async ({ page }) => {
      await stub(page, { json: { explainers: EXPLAINERS } });
      await gotoAdmin(page, 'intelligence');
      const cards = main(page).locator('.ac-xp-card');
      await expect(cards).toHaveCount(2);
      const a = cards.first();
      await expect(a.getByRole('heading', { level: 2 })).toHaveText('Assessment Explainer');
      await expect(a).toContainText('claude-test-1');
      await expect(a.locator('dd')).toHaveText(['assessment', 'Residents', 'POST /explain (topic: assessment)']);
      await expect(a).toContainText('Injected context (2)');
      // A plugin with nothing set shows dashes and no context section.
      const t = cards.nth(1);
      await expect(t.locator('dd')).toHaveText(['tax', '—', '—']);
      await expect(t.locator('.ac-xp-model')).toHaveText('—');
      await expect(t).not.toContainText('Injected context');
    });

    test('the system prompt and each context block open and close; text shows as text', async ({ page }) => {
      await stub(page, { json: { explainers: EXPLAINERS } });
      await gotoAdmin(page, 'intelligence');
      const a = main(page).locator('.ac-xp-card').first();
      const prompt = a.getByRole('button', { name: /System prompt/ });
      await expect(prompt).toHaveAttribute('aria-expanded', 'false');
      await expect(prompt).toContainText('▸');
      await expect(prompt).toContainText('23 chars');
      await expect(a.getByText('Explain <b>plainly</b>.')).toBeHidden();
      await prompt.click();
      await expect(prompt).toHaveAttribute('aria-expanded', 'true');
      await expect(prompt).toContainText('▾');
      await expect(a.getByText('Explain <b>plainly</b>.')).toBeVisible();
      await prompt.click();
      await expect(a.getByText('Explain <b>plainly</b>.')).toBeHidden();

      const glossary = a.getByRole('button', { name: /Glossary/ });
      await expect(glossary).toContainText('27 chars');
      await glossary.click();
      await expect(a.getByText('SEV = state equalized value')).toBeVisible();
      await expect(a.getByText('MCL 211.27a')).toBeHidden();   // the other block stays closed
    });

    test('no plugins, or no Map Buddy, says so', async ({ page, consoleGuard }) => {
      consoleGuard.allow(/status of 502/);
      await stub(page, { json: { explainers: [] } });
      await gotoAdmin(page, 'intelligence');
      await expect(main(page)).toContainText('No explainer plugins registered.');

      await page.unroute('**/explainers');
      await stub(page, { status: 502, body: 'bad gateway' });
      await navItem(page, 'county').click();
      await navItem(page, 'intelligence').click();
      await expect(main(page)).toContainText('Couldn’t reach the Map Buddy service (HTTP 502)');
    });
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

    // Layer discovery (DIC-502), signed in: pick a serveable layer, see what it is, add it.
    const DISCOVERED = [
      { id: 'drain_lines', source: 'drain_lines_tiles', sourceLayer: 'drain_lines', geomType: 'line', rowCount: 1234,
        dbSource: 'geo.drain_lines', fields: ['name', 'kind'] },
      { id: 'parks', source: 'parks_tiles', sourceLayer: 'parks', geomType: 'polygon', registered: true },
      { id: 'subdivisions', source: 'subdivisions_tiles', geomType: 'polygon' },   // already in the config
      { id: 'wells', source: 'wells_tiles', geomType: 'point' },
    ];
    const pick = (page) => main(page).getByRole('combobox', { name: 'PostGIS layer' });

    test('discovery lists the layers not yet added; picking one shows what it is; Add puts it in the draft', async ({ page, consoleGuard }) => {
      consoleGuard.allow(/status of 404/);
      const seen = {};
      await stubSignIn(page, seen);
      await page.route('**/api/admin/discover/layers*', (route) => route.fulfill({ json: { layers: DISCOVERED } }));
      await page.route('**/api/config/*/draft', async (route) => {
        if (route.request().method() === 'GET') return route.fulfill({ status: 404, json: {} });
        seen.saved = route.request().postDataJSON();
        await route.fulfill({ json: { ok: true } });
      });
      await gotoAdmin(page, 'data');
      await signIn(page);

      await expect(pick(page)).toBeEnabled();
      await expect(pick(page).locator('option')).toHaveText(['Select a layer to add…', 'Drain Lines — line, 1,234 features', 'Wells — point']);
      await main(page).getByRole('button', { name: 'Add layer' }).click();
      await expect(page.getByTestId('ac-flash')).toHaveText('Pick a layer to add first.');

      await pick(page).selectOption('drain_lines_tiles');
      const meta = main(page).locator('#ac-pg-pick-meta');
      await expect(meta.locator('dd')).toHaveText(['line', '1,234', 'geo.drain_lines', 'drain_lines_tiles']);

      await main(page).getByRole('button', { name: 'Add layer' }).click();
      await expect(page.getByTestId('ac-flash')).toHaveText('Added “Drain Lines”. Publish to make it live in the viewer.');
      await expect(main(page).getByRole('button', { name: 'Save draft' })).toBeVisible();   // now editing
      await expect(card(page, 'PostGIS layers').locator('[data-path$=".label"]').last()).toHaveValue('Drain Lines');
      await expect(pick(page).locator('option')).toHaveText(['Select a layer to add…', 'Wells — point']);

      await main(page).getByRole('button', { name: 'Save draft' }).click();
      await expect(page.getByTestId('ac-flash')).toHaveText('Draft saved.');
      const p = seen.saved.payload;
      expect(p.layers.overlays.at(-1)).toEqual({ id: 'drain_lines', label: 'Drain Lines', type: 'vector', source: 'drain_lines_tiles',
        sourceLayer: 'drain_lines', geomType: 'line', minZoom: 12, default: false, dbSource: 'geo.drain_lines', fields: ['name', 'kind'] });
      expect(p.styling.layers.drain_lines).toEqual({ label: 'Drain Lines',
        paint: { light: { fill: '#1F5E80', stroke: '#1F5E80' }, dark: { fill: '#2E76A6', stroke: '#7fb6d8' } } });
    });

    test('discovery says why when there is nothing to add, it is not allowed, or the DB is down', async ({ page, consoleGuard }) => {
      consoleGuard.allow(/status of (403|500)/);
      await stubSignIn(page, {});
      const replies = [{ json: { layers: [DISCOVERED[1]] } }, { status: 403, json: {} }, { status: 500, json: {} }];
      await page.route('**/api/admin/discover/layers*', (route) => route.fulfill(replies.shift()));
      await gotoAdmin(page, 'county');
      await signIn(page);
      for (const text of [/All available layers added/, /isn’t allowed for this account/, /Couldn’t reach the tile server \/ DB \(HTTP 500\)/]) {
        await navItem(page, 'data').click();
        await expect(main(page)).toContainText(text);
        await expect(pick(page)).toBeDisabled();
        await navItem(page, 'county').click();
      }
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

    // Access & Ops (DIC-462): what each row shows, and that its editor sends each field
    // with its type.

    // County Configuration (DIC-458): what each row shows from the live config, and the
    // reference lookups.
    test('county: shows the live identity, map defaults, endpoints and parcel-number format', async ({ page }) => {
      const cfg = await (await page.request.get('/api/config')).json();
      const pn = cfg.parcelNumber || {};
      await gotoAdmin(page, 'county');
      await expect(main(page)).toContainText('Loaded live from the runtime /config API');
      const show = (v) => (v == null || v === '' ? '—' : String(v));
      await expect(dd(card(page, 'Identity'), 'Name')).toHaveText(show(cfg.name));
      await expect(dd(card(page, 'Identity'), 'State')).toHaveText(show(cfg.state));
      await expect(dd(card(page, 'Identity'), 'Data request form')).toHaveText(show(cfg.forms && cfg.forms.dataRequest));
      const mapCard = card(page, 'Map defaults');
      await expect(dd(mapCard, 'Center \\[lng, lat\\]')).toHaveText(JSON.stringify(cfg.map.center));
      await expect(dd(mapCard, 'Default zoom')).toHaveText(show(cfg.map.zoom));
      await expect(dd(mapCard, 'Extent')).toHaveText(JSON.stringify(cfg.map.extent));
      await expect(dd(card(page, 'Endpoints'), 'Map Buddy AI')).toHaveText(show(cfg.endpoints && cfg.endpoints.mapBuddy));
      await expect(dd(card(page, 'Integrations'), 'Google Maps Embed key')).toHaveText(show(cfg.integrations && cfg.integrations.googleMapsEmbedKey));
      const pnCard = card(page, 'Parcel number format');
      await expect(dd(pnCard, 'Separator')).toHaveText(show(pn.separator));
      await expect(dd(pnCard, 'Example PIN')).toHaveText(show(pn.example));
      const segs = pn.segments || [];
      await expect(pnCard.locator('tbody tr')).toHaveCount(Math.max(segs.length, 1));
      if (segs.length) await expect(pnCard.locator('tbody tr').first()).toHaveText(new RegExp('^1' + segs[0].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      await expect(formField(main(page))).toHaveCount(0);
    });

    test('county: reference lookups open one at a time, sorted by code', async ({ page }) => {
      const cfg = await (await page.request.get('/api/config')).json();
      const pc = (cfg.labels && cfg.labels.propClass) || {};
      const sd = (cfg.labels && cfg.labels.schoolDist) || {};
      await gotoAdmin(page, 'county');
      const lk = card(page, 'Reference lookups');
      await expect(dd(lk, 'Property classes')).toHaveText(`${Object.keys(pc).length} codes View`);
      await expect(dd(lk, 'School districts')).toHaveText(`${Object.keys(sd).length} codes View`);

      const view = lk.getByRole('button', { name: 'View' });
      await view.first().click();
      await expect(dd(lk, 'Property classes').getByRole('button')).toHaveText('Hide');
      const rows = lk.getByRole('table').locator('tbody tr');
      await expect(rows).toHaveCount(Object.keys(pc).length);
      const first = Object.keys(pc).sort()[0];
      await expect(rows.first()).toHaveText(first + pc[first]);

      await dd(lk, 'School districts').getByRole('button').click();
      await expect(dd(lk, 'Property classes').getByRole('button')).toHaveText('View');
      await expect(dd(lk, 'School districts').getByRole('button')).toHaveText('Hide');
      await expect(rows).toHaveCount(Object.keys(sd).length);

      await dd(lk, 'School districts').getByRole('button').click();
      await expect(lk.getByRole('table')).toHaveCount(0);
      await expect(lk.getByRole('button', { name: 'View' })).toHaveCount(2);
    });

    test('county: every field is in the editor, starting from the live value', async ({ page, consoleGuard }) => {
      const cfg = await (await page.request.get('/api/config')).json();
      await stubStore(page, consoleGuard, {});
      await gotoAdmin(page, 'county');
      await main(page).getByRole('button', { name: 'Edit configuration' }).click();
      await expect(main(page)).toContainText('Editing a draft.');
      await expect(draftField(page, 'state')).toHaveValue(cfg.state || '');
      await expect(draftField(page, 'map.center')).toHaveValue(JSON.stringify(cfg.map.center));
      await expect(draftField(page, 'map.zoom')).toHaveValue(String(cfg.map.zoom));
      await expect(draftField(page, 'endpoints.mapBuddy')).toHaveValue((cfg.endpoints && cfg.endpoints.mapBuddy) || '');
      await expect(draftField(page, 'integrations.googleMapsEmbedKey')).toHaveValue((cfg.integrations && cfg.integrations.googleMapsEmbedKey) || '');
      await expect(draftField(page, 'parcelNumber.intro')).toHaveValue((cfg.parcelNumber && cfg.parcelNumber.intro) || '');
      await expect(card(page, 'Reference lookups')).toContainText('edit via API for now');
      // Clearing the zoom saves no zoom rather than 0.
      const seen = {};
      await page.unroute('**/api/config/*/draft');
      await stubStore(page, consoleGuard, seen);
      await draftField(page, 'map.zoom').fill('');
      await main(page).getByRole('button', { name: 'Save draft' }).click();
      await expect(page.getByTestId('ac-flash')).toHaveText('Draft saved.');
      expect(seen.saved.payload.map.zoom).toBeNull();
    });

    // Data & Layers (DIC-461): the tile server, the PostGIS layers (editable), the WMS /
    // raster overlays (read-only), and the data sources.
    const isPg = (o) => ['vector', 'postgis', 'mvt'].includes(String(o.type || '').toLowerCase());
    const zoomText = (o) => (o.minZoom ? `z${o.minZoom}+` : 'all');

    test('data: shows the tile server, layers, overlays and sources as the live config has them', async ({ page }) => {
      const cfg = await (await page.request.get('/api/config')).json();
      const L = cfg.layers || {};
      const overlays = L.overlays || [];
      await gotoAdmin(page, 'data');
      await expect(main(page)).toContainText('Loaded live from /config.');
      const ts = card(page, 'Tile server');
      await expect(dd(ts, 'Provider')).toHaveText((L.tileServer && L.tileServer.provider) || '—');
      await expect(dd(ts, 'URL')).toHaveText((L.tileServer && L.tileServer.url) || '—');
      const pg = overlays.filter(isPg);
      const pgCard = card(page, 'PostGIS layers');
      await expect(pgCard).toContainText(`${pg.length} vector layer(s)`);
      await expect(pgCard.locator('tbody tr')).toHaveText(pg.map((o) => o.label + (o.source || '—') + zoomText(o) + (o.default ? 'on' : '')));
      const ext = overlays.filter((o) => !isPg(o));
      await expect(card(page, 'External overlays').locator('tbody tr')).toHaveText(ext.map((o) => o.label + o.type + o.source + zoomText(o)));
      const ds = L.dataSources || [];
      await expect(card(page, 'Data sources').locator('tbody tr')).toHaveText(ds.map((d) => d.label + d.source));
      await expect(card(page, 'Data sources')).toContainText('Self-serve ingestion');
      await expect(main(page).getByRole('combobox', { name: 'PostGIS layer' })).toBeDisabled();
    });

    test('data: the editor edits the PostGIS layers and data sources; overlays stay read-only', async ({ page, consoleGuard }) => {
      const cfg = await (await page.request.get('/api/config')).json();
      const overlays = cfg.layers.overlays;
      const firstPg = overlays.findIndex(isPg);
      const seen = {};
      await stubStore(page, consoleGuard, seen);
      await gotoAdmin(page, 'data');
      await main(page).getByRole('button', { name: 'Edit layers' }).click();
      await expect(main(page)).toContainText('Editing a draft.');
      await expect(draftField(page, `layers.overlays.${firstPg}.label`)).toHaveValue(overlays[firstPg].label);
      await expect(formField(card(page, 'External overlays'))).toHaveCount(0);

      await draftField(page, 'layers.tileServer.url').fill('/tiles-2');
      await draftField(page, `layers.overlays.${firstPg}.minZoom`).fill('9');
      await draftField(page, `layers.overlays.${firstPg}.default`).check();
      const pgRows = card(page, 'PostGIS layers').locator('tbody tr');
      const before = await pgRows.count();
      await main(page).getByRole('button', { name: '+ Add PostGIS layer' }).click();
      await expect(pgRows).toHaveCount(before + 1);
      await draftField(page, `layers.overlays.${overlays.length}.source`).fill('new_tiles');
      const dsRows = card(page, 'Data sources').locator('tbody tr');
      const dsBefore = await dsRows.count();
      await main(page).getByRole('button', { name: '+ Add data source' }).click();
      await expect(dsRows).toHaveCount(dsBefore + 1);
      await card(page, 'Data sources').getByRole('button', { name: 'Remove' }).first().click();
      await expect(dsRows).toHaveCount(dsBefore);
      await main(page).getByRole('button', { name: 'Save draft' }).click();
      await expect(page.getByTestId('ac-flash')).toHaveText('Draft saved.');

      const L = seen.saved.payload.layers;
      expect(L.tileServer.url).toBe('/tiles-2');
      expect(L.overlays[firstPg]).toMatchObject({ minZoom: 9, default: true });
      expect(L.overlays.at(-1)).toEqual({ id: '', label: 'New PostGIS layer', type: 'vector', source: 'new_tiles', minZoom: 0, default: false });
      expect(L.dataSources).toHaveLength(cfg.layers.dataSources.length);
      expect(L.dataSources[0]).toEqual(cfg.layers.dataSources[1]);
    });

    // Styling (DIC-460 / DIC-503), against a stubbed /config with known styling: a polygon
    // layer with a choropleth, a line layer and a point layer.
    const STYLED = {
      name: 'Styled County',
      layers: { overlays: [
        { id: 'roads', label: 'Roads', type: 'vector', source: 'roads_tiles', geomType: 'line', fields: ['name', 'feature_type'] },
        { id: 'wells', label: 'Wells', type: 'vector', source: 'wells_tiles', geomType: 'point' },
      ] },
      styling: {
        colorScheme: 'harvest', theme: 'light', basemap: 'parcels',
        schemes: [{ id: 'harvest', label: 'Harvest', accent: '#a3473b', interactive: '#2f6b4f' }, { id: 'lake', label: 'Lake', accent: '#1f5e80', interactive: '#7fb6d8' }],
        labels: { defaultField: 'owner', defaultSize: 'medium', fields: ['owner', 'pin'], zoom: { largeParcels: 13, smallParcels: 15 } },
        layers: {
          parcels: { label: 'Parcels', paint: { light: { fill: '#f5f0e8', stroke: '#6b5d4f' }, dark: { fill: '#2a2420', stroke: '#9a8b7c' } },
            choropleth: { enabled: true, attribute: 'prop_class', mode: 'categorical', transform: 'classGroup', fallback: '#cccccc', opacity: 0.2,
              fields: ['prop_class', 'gis_acres'], categories: [{ value: '4', label: 'Residential', color: '#e8c07d' }], stops: [] } },
          roads: { label: 'Roads', line: { width: 2, opacity: 0.9, dash: 'dashed', casingWidth: 1, light: { color: '#333333' }, dark: {} },
            labels: { enabled: true, field: 'name', size: 11, minZoom: 14 } },
          wells: { label: 'Wells', point: { radius: 4, strokeWidth: 1, light: { color: '#b58d4a' }, dark: {} } },
        },
      },
    };
    async function gotoStyled(page, cfg = STYLED) {
      await page.route('**/api/config', (route) => route.fulfill({ json: cfg }));
      await gotoAdmin(page, 'styling');
      await expect(status(page)).toHaveText('Live config · read-only');
    }
    const stylePick = (page) => card(page, 'Layer styling').getByRole('combobox').first();

    test('styling: shows the schemes, theme, the picked layer by its geometry, and parcel labels', async ({ page }) => {
      await gotoStyled(page);
      const schemes = card(page, 'Color scheme');
      await expect(schemes).toContainText('default: harvest');
      await expect(schemes.locator('.ac-scheme')).toHaveText(['Harvest default', 'Lake']);
      await expect(schemes.locator('.is-active')).toHaveText('Harvest default');
      await expect(dd(card(page, 'Theme & basemap'), 'Default theme')).toHaveText('light');
      await expect(dd(card(page, 'Theme & basemap'), 'Base layer')).toHaveText('parcels');

      // Parcels: polygon paint, the choropleth with its categories, and no label fields.
      const ls = card(page, 'Layer styling');
      await expect(stylePick(page).locator('option')).toHaveText(['Parcels', 'Roads', 'Wells']);
      await expect(ls).toContainText('fill, stroke & choropleth');
      await expect(dd(ls, 'Light — fill')).toHaveText('#f5f0e8');
      await expect(dd(card(page, 'Choropleth'), 'Mode')).toHaveText('categorical · classGroup');
      await expect(dd(card(page, 'Choropleth'), 'Opacity')).toHaveText('0.2');
      await expect(card(page, 'Categories').locator('tbody tr')).toHaveText(['#e8c07d4Residential']);
      await expect(card(page, 'Labels')).toContainText('text at each feature');
      await expect(dd(card(page, 'Labels'), 'Labels')).toHaveText('Off');

      // A line layer: width, dash, casing; its labels along the line; no choropleth.
      await stylePick(page).selectOption('roads');
      await expect(ls).toContainText('line — casing, dash & glow');
      await expect(dd(ls, 'Width')).toHaveText('2 px');
      await expect(dd(ls, 'Dash')).toHaveText('dashed');
      await expect(dd(ls, 'Glow width')).toHaveText('— blurred halo (0 = none)');
      await expect(ls).toContainText('Width-by-type needs');
      await expect(card(page, 'Choropleth')).toHaveCount(0);
      await expect(card(page, 'Labels')).toContainText('text along the line');
      await expect(dd(card(page, 'Labels'), 'Size · min zoom')).toHaveText('11px · z14+');

      // A point layer whose tiles have no attributes.
      await stylePick(page).selectOption('wells');
      await expect(ls).toContainText('point — radius & stroke');
      await expect(dd(ls, 'Radius')).toHaveText('4 px');
      await expect(card(page, 'Labels')).toContainText('This layer’s tiles expose no label-able attributes.');

      const pl = card(page, 'Parcel labels');
      await expect(dd(pl, 'Default field')).toHaveText('owner');
      await expect(dd(pl, 'Zoom — large / small')).toHaveText('large 13+, small 15+');
      await expect(formField(main(page)).filter({ hasNot: page.locator('[data-style-layer]') })).toHaveCount(1);   // only the picker
    });

    test('styling: edits the scheme, the paint, the choropleth ramp and labels, and saves them', async ({ page, consoleGuard }) => {
      const seen = {};
      await stubStore(page, consoleGuard, seen);
      await gotoStyled(page);
      await main(page).getByRole('button', { name: 'Edit styling' }).click();
      await expect(main(page)).toContainText('Editing a draft.');
      await card(page, 'Color scheme').getByRole('button', { name: /Lake/ }).click();
      await expect(card(page, 'Color scheme').locator('.is-active')).toHaveText('Lake default');
      await draftField(page, 'styling.theme').selectOption('dark');
      await draftField(page, 'styling.layers.parcels.paint.light.fill').fill('#112233');
      await draftField(page, 'styling.layers.parcels.choropleth.opacity').fill('0.35');

      // Switching the mode swaps the ramp; rows add and remove.
      await draftField(page, 'styling.layers.parcels.choropleth.mode').selectOption('graduated');
      await expect(card(page, 'Color stops').locator('tbody')).toHaveText('No stops yet — add one below.');
      await expect(card(page, 'Categories')).toHaveCount(0);
      await main(page).getByRole('button', { name: '+ Add stop' }).click();
      await main(page).getByRole('button', { name: '+ Add stop' }).click();
      await draftField(page, 'styling.layers.parcels.choropleth.stops.1.min').fill('100000');
      await card(page, 'Color stops').getByRole('button', { name: 'Remove' }).first().click();
      await expect(card(page, 'Color stops').locator('tbody tr')).toHaveCount(1);

      // The picker keeps the edits while it moves between layers.
      await stylePick(page).selectOption('roads');
      await draftField(page, 'styling.layers.roads.line.dash').selectOption('dotted');
      await draftField(page, 'styling.layers.roads.labels.enabled').uncheck();
      await stylePick(page).selectOption('parcels');
      await expect(draftField(page, 'styling.layers.parcels.paint.light.fill')).toHaveValue('#112233');
      await draftField(page, 'styling.labels.zoom.largeParcels').fill('12');

      await main(page).getByRole('button', { name: 'Save draft' }).click();
      await expect(page.getByTestId('ac-flash')).toHaveText('Draft saved.');
      const S = seen.saved.payload.styling;
      expect(S).toMatchObject({ colorScheme: 'lake', theme: 'dark', labels: { zoom: { largeParcels: 12 } } });
      expect(S.layers.parcels.paint.light.fill).toBe('#112233');
      expect(S.layers.parcels.choropleth).toMatchObject({ mode: 'graduated', opacity: 0.35, stops: [{ min: 100000, label: '', color: '#888888' }] });
      expect(S.layers.roads.line.dash).toBe('dotted');
      expect(S.layers.roads.labels.enabled).toBe(false);
    });

    test('styling: a config without styling says so; one without layers says that', async ({ page }) => {
      await gotoStyled(page, { name: 'Plain County' });
      await expect(main(page)).toContainText('No styling config in the manifest yet.');
      await page.unroute('**/api/config');
      await page.route('**/api/config', (route) => route.fulfill({ json: { name: 'Plain County', styling: { schemes: [], labels: {} } } }));
      await page.reload();
      await expect(card(page, 'Layer styling')).toContainText('No stylable layers in the manifest yet.');
      await expect(card(page, 'Choropleth')).toHaveCount(0);
    });

    test('access: shows the live access settings and the services, read-only', async ({ page }) => {
      const cfg = await (await page.request.get('/api/config')).json();
      const A = cfg.access || {};
      await gotoAdmin(page, 'access');
      await expect(main(page)).toContainText('Loaded live from /config.');
      const access = card(page, 'Access');
      await expect(dd(access, 'Access model')).toHaveText(A.model || '—');
      await expect(dd(access, 'Assessment data')).toHaveText(A.assessmentDataPublic ? 'Public' : 'Gated');
      await expect(dd(access, 'Data request form')).toHaveText((cfg.forms && cfg.forms.dataRequest) || '—');
      await expect(dd(access, 'Error reports go to')).toHaveText(A.reportTo || '—');
      await expect(dd(access, 'Rate limited')).toHaveText(A.rateLimited ? 'Yes' : 'No');
      const services = card(page, 'Services');
      await expect(dd(services, 'Parcel API')).toHaveText('/api');
      await expect(dd(services, 'Tile server')).toHaveText((cfg.layers && cfg.layers.tileServer && cfg.layers.tileServer.url) || '/tiles');
      await expect(dd(services, 'Map Buddy AI')).toHaveText((cfg.endpoints && cfg.endpoints.mapBuddy) || '—');
      await expect(card(page, 'Planned (DIC-462)').getByRole('listitem')).toHaveCount(5);
      await expect(formField(main(page))).toHaveCount(0);
    });

    test('access: the editor starts from the live values and saves each field with its type', async ({ page, consoleGuard }) => {
      const cfg = await (await page.request.get('/api/config')).json();
      const A = cfg.access || {};
      const seen = {};
      await stubStore(page, consoleGuard, seen);
      await gotoAdmin(page, 'access');
      await main(page).getByRole('button', { name: 'Edit access' }).click();
      await expect(main(page)).toContainText('Editing a draft.');
      await expect(draftField(page, 'access.model')).toHaveValue(A.model || '');
      await expect(draftField(page, 'access.reportTo')).toHaveValue(A.reportTo || '');
      await expect(draftField(page, 'forms.dataRequest')).toHaveValue((cfg.forms && cfg.forms.dataRequest) || '');
      await expect(draftField(page, 'access.assessmentDataPublic')).toBeChecked({ checked: !!A.assessmentDataPublic });
      // The services stay read-only while editing.
      await expect(formField(card(page, 'Services'))).toHaveCount(0);

      await draftField(page, 'access.model').fill('Staff only');
      await draftField(page, 'forms.dataRequest').fill('https://forms.example.test/req');
      await draftField(page, 'access.assessmentDataPublic').setChecked(!A.assessmentDataPublic);
      await draftField(page, 'access.rateLimited').setChecked(!A.rateLimited);
      await main(page).getByRole('button', { name: 'Save draft' }).click();
      await expect(page.getByTestId('ac-flash')).toHaveText('Draft saved.');
      expect(seen.saved.payload.access).toMatchObject({
        model: 'Staff only', assessmentDataPublic: !A.assessmentDataPublic, rateLimited: !A.rateLimited,
      });
      expect(seen.saved.payload.forms.dataRequest).toBe('https://forms.example.test/req');

      await main(page).getByRole('button', { name: 'Cancel' }).click();
      await expect(dd(card(page, 'Access'), 'Access model')).toHaveText(A.model || '—');
    });

    test('access: history and Restore stay on Access & Ops', async ({ page, consoleGuard }) => {
      const seen = {};
      await stubStore(page, consoleGuard, seen, { versions: [{ version: 4, note: 'Inbox', created_by: 'jerry', created_at: '2026-05-01T10:00:00Z' }] });
      await gotoAdmin(page, 'access');
      await main(page).getByRole('button', { name: 'Version history' }).click();
      await expect(main(page)).toContainText('1 published version(s)');
      await main(page).getByRole('button', { name: 'Restore' }).click();
      await expect(page.getByTestId('ac-flash')).toHaveText('Restored v4 as version 8.');
      await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Access & Ops');
      await expect(main(page).getByRole('button', { name: 'Restore' })).toBeVisible();   // history redrawn
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
