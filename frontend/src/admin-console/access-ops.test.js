// Access & Ops as a Vue module (DIC-2389; was admin.js renderAccess), with the module
// frame and edit flow it shares. A real console store runs over a faked API; the e2e
// suite covers the same flows against the stack (admin-console.spec.js, "access: …").
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import AccessOps from './modules/AccessOps.vue';
import { createConsoleStore } from './store.js';

const reply = (status, json = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

const CONFIG = {
  name: 'Test County',
  access: { model: 'Public', assessmentDataPublic: true, reportTo: 'gis@test.gov', rateLimited: false },
  forms: { dataRequest: 'https://forms.test/req' },
  layers: { tileServer: { url: '/tiles-x' } },
  endpoints: { mapBuddy: '/mb' },
};

function setup(routes = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, opts = {}) => {
    const key = (opts.method || 'GET') + ' ' + url.replace('/api', '');
    calls.push({ key, body: opts.body ? JSON.parse(opts.body) : undefined });
    const r = routes[key];
    return (Array.isArray(r) ? r.shift() : r) || reply(404);
  });
  const store = createConsoleStore({
    fetch, apiBase: () => '/api', auth: { headers: () => ({}), noteRefused: () => false },
    countyKey: 'test', author: 'console', fallback: structuredClone(CONFIG),
    local: () => ({ setItem: vi.fn(), removeItem: vi.fn() }), open: vi.fn(),
  });
  store.show('access');
  const w = mount(AccessOps, { props: { store } });
  return { store, w, calls };
}

// The value next to a row's label.
const row = (w, label) => w.findAll('dt').find((dt) => dt.text() === label).element.nextElementSibling.textContent.trim();
const btn = (w, name) => w.findAll('button').find((b) => b.text() === name);
const field = (w, path) => w.get(`[data-path="${path}"]`);

describe('AccessOps', () => {
  it('shows the access settings and the services, read-only', () => {
    const { w } = setup();
    expect(w.get('h1').text()).toBe('Access & Ops');
    expect(row(w, 'Access model')).toBe('Public');
    expect(row(w, 'Assessment data')).toBe('Public');
    expect(row(w, 'Data request form')).toBe('https://forms.test/req');
    expect(row(w, 'Error reports go to')).toBe('gis@test.gov');
    expect(row(w, 'Rate limited')).toBe('No');
    expect(row(w, 'Parcel API')).toBe('/api');
    expect(row(w, 'Tile server')).toBe('/tiles-x');
    expect(row(w, 'Map Buddy AI')).toBe('/mb');
    expect(w.findAll('.ac-plan li')).toHaveLength(5);
    expect(w.findAll('input')).toHaveLength(0);
    expect(w.get('.ac-banner').text()).toContain('Showing the baked manifest fallback.');
  });

  it('empty settings show dashes and defaults', () => {
    const { store, w } = setup();
    store.state.config = {};
    return w.vm.$nextTick().then(() => {
      expect(row(w, 'Access model')).toBe('—');
      expect(row(w, 'Assessment data')).toBe('Gated');
      expect(row(w, 'Data request form')).toBe('—');
      expect(row(w, 'Tile server')).toBe('/tiles');
      expect(row(w, 'Map Buddy AI')).toBe('—');
    });
  });

  it('Edit opens the form on the draft; each field changes the draft with its type; Save sends it', async () => {
    const { store, w, calls } = setup({ 'PUT /config/test/draft': reply(200) });
    await btn(w, 'Edit access').trigger('click');
    await flushPromises();
    expect(w.get('.ac-banner-edit').text()).toContain('Editing a draft.');
    expect(field(w, 'access.model').element.value).toBe('Public');
    expect(field(w, 'access.assessmentDataPublic').element.checked).toBe(true);
    expect(w.findAll('.ac-card')[1].findAll('input')).toHaveLength(0);   // services stay read-only

    await field(w, 'access.model').setValue('Staff only');
    await field(w, 'access.reportTo').setValue('new@test.gov');
    await field(w, 'forms.dataRequest').setValue('https://forms.test/new');
    await field(w, 'access.assessmentDataPublic').setValue(false);
    await field(w, 'access.rateLimited').setValue(true);
    expect(store.state.draft.access).toEqual({ model: 'Staff only', assessmentDataPublic: false, reportTo: 'new@test.gov', rateLimited: true });
    expect(store.state.config.access.model).toBe('Public');

    await btn(w, 'Save draft').trigger('click');
    await flushPromises();
    expect(calls.at(-1)).toMatchObject({ key: 'PUT /config/test/draft', body: { payload: { forms: { dataRequest: 'https://forms.test/new' } } } });
    expect(w.get('[data-testid="ac-flash"] .ac-flash-ok').text()).toBe('Draft saved.');
  });

  it('a saved server draft fills the form; Cancel goes back to the live values', async () => {
    const { w } = setup({ 'GET /config/test/draft': reply(200, { access: { model: 'Drafted' } }) });
    await btn(w, 'Edit access').trigger('click');
    await flushPromises();
    expect(field(w, 'access.model').element.value).toBe('Drafted');
    await btn(w, 'Cancel').trigger('click');
    expect(row(w, 'Access model')).toBe('Public');
  });

  it('a refused save says why and keeps the form; Publish returns to the live view', async () => {
    const { w } = setup({
      'PUT /config/test/draft': [reply(503), reply(200)],
      'POST /config/test/publish': reply(200, { version: 5 }),
      'GET /config': reply(200, { ...CONFIG, access: { model: 'Published' } }),
    });
    await btn(w, 'Edit access').trigger('click');
    await btn(w, 'Save draft').trigger('click');
    await flushPromises();
    expect(w.get('.ac-flash-err').text()).toMatch(/not yet provisioned/);
    expect(btn(w, 'Save draft')).toBeTruthy();

    await btn(w, 'Publish').trigger('click');
    await flushPromises();
    expect(w.get('.ac-flash-ok').text()).toBe('Published version 5.');
    expect(row(w, 'Access model')).toBe('Published');
    expect(w.get('.ac-banner').text()).toContain('Loaded live from /config.');
  });

  it('Version history lists versions; Restore rolls back, says so and reloads the list', async () => {
    const { w, calls } = setup({
      'GET /config/test/versions': [reply(200, { versions: [{ version: 2, note: 'n', created_by: 'j', created_at: '2026-05-01T10:00:00Z' }] }),
        reply(200, { versions: [{ version: 3 }, { version: 2 }] })],
      'POST /config/test/rollback': reply(200, { version: 3 }),
      'GET /config': reply(200, CONFIG),
    });
    await btn(w, 'Version history').trigger('click');
    expect(w.get('#ac-history').text()).toContain('Loading…');
    await flushPromises();
    expect(w.get('#ac-history').text()).toContain('1 published version(s)');
    expect(w.get('#ac-history tbody td:nth-child(4)').text()).toBe('2026-05-01 10:00:00');

    await btn(w, 'Restore').trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.key === 'POST /config/test/rollback').body).toEqual({ version: 2, author: 'console' });
    expect(w.get('.ac-flash-ok').text()).toBe('Restored v2 as version 3.');
    expect(w.get('#ac-history').text()).toContain('2 published version(s)');
  });

  it('history says why when refused, and when there are none; Edit closes it', async () => {
    const { w } = setup({ 'GET /config/test/versions': [reply(401), reply(200, { versions: [] })] });
    await btn(w, 'Version history').trigger('click');
    await flushPromises();
    expect(w.get('#ac-history').text()).toContain('Sign in as staff to save');
    await btn(w, 'Version history').trigger('click');
    await flushPromises();
    expect(w.get('#ac-history').text()).toContain('No published versions yet.');
    await btn(w, 'Edit access').trigger('click');
    expect(w.get('#ac-history').text()).toBe('');
  });
});
