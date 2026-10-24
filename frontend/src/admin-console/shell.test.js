// The Admin Console's shell, config store and draft helpers (DIC-2389; were admin.js).
// The API and the modules are faked here; the e2e suite drives the real console
// with the config store's routes stubbed (admin-console.spec.js, "shell and edit flow").
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import AdminConsole from './AdminConsole.vue';
import { MODULES } from './modules.js';
import { arrayAdd, arrayAt, arrayRemove, getPath, setPath, templateFor } from './draft.js';
import { createConsoleStore } from './store.js';

const reply = (status, json = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

// A console store over a fake API: `routes` maps "METHOD /path" to a reply (or a list of
// replies, used in turn); every call is recorded in `calls`.
function setup(routes = {}, { fallback = { name: 'Baked County', map: { zoom: 9 } } } = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, opts = {}) => {
    const key = (opts.method || 'GET') + ' ' + url.replace('/api', '');
    calls.push({ key, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : undefined });
    const r = routes[key];
    const next = Array.isArray(r) ? r.shift() : r;
    if (next instanceof Error) throw next;
    return next || reply(404);
  });
  const auth = { headers: () => ({ Authorization: 'Token t' }), noteRefused: vi.fn((s) => s === 401) };
  const local = memoryStorage();
  const open = vi.fn();
  const store = createConsoleStore({
    fetch, apiBase: () => '/api', auth, countyKey: 'vanburen', author: 'console',
    fallback, local: () => local, open,
  });
  return { store, calls, auth, local, open };
}

describe('draft helpers', () => {
  it('set and get by dotted path, making the objects on the way', () => {
    const o = {};
    setPath(o, 'map.center', [1, 2]);
    setPath(o, 'styling.layers.roads.line.width', 3);
    expect(o).toEqual({ map: { center: [1, 2] }, styling: { layers: { roads: { line: { width: 3 } } } } });
    expect(getPath(o, 'styling.layers.roads.line.width')).toBe(3);
    expect(getPath(o, 'styling.nope.deeper')).toBeUndefined();
  });

  it('refuses paths that reach the object prototype', () => {
    for (const p of ['__proto__.polluted', 'a.constructor.prototype.x', 'prototype']) {
      expect(() => setPath({}, p, 1)).toThrow(/Unsafe config path/);
      expect(() => getPath({}, p)).toThrow(/Unsafe config path/);
    }
    expect({}.polluted).toBeUndefined();
  });

  it('adds rows from the template for the list, also under a per-layer path; removes by index', () => {
    const o = { parcelNumber: { segments: [{ name: 'a', description: '' }] } };
    arrayAdd(o, 'parcelNumber.segments');
    expect(o.parcelNumber.segments[1]).toEqual({ name: '', description: '' });
    arrayAdd(o, 'styling.layers.parcels.choropleth.stops');
    expect(o.styling.layers.parcels.choropleth.stops).toEqual([{ min: 0, label: '', color: '#888888' }]);
    expect(templateFor('something.else')).toEqual({});
    arrayRemove(o, 'parcelNumber.segments', 0);
    arrayRemove(o, 'parcelNumber.segments', 5);   // out of range: no change
    expect(o.parcelNumber.segments).toEqual([{ name: '', description: '' }]);
    // Each row is its own copy of the template.
    arrayAdd(o, 'parcelNumber.segments');
    o.parcelNumber.segments[0].name = 'x';
    expect(o.parcelNumber.segments[1].name).toBe('');
    expect(arrayAt({ a: 'not a list' }, 'a')).toEqual([]);
  });
});

describe('console store', () => {
  it('starts on the baked config, and takes /config when it answers', async () => {
    const { store } = setup({ 'GET /config': [reply(503), reply(200, { error: 'x' }), reply(200, { name: 'Live' })] });
    expect(store.state.config.name).toBe('Baked County');
    await store.loadConfig();
    await store.loadConfig();
    expect(store.state.source).toBe('fallback');
    await store.loadConfig();
    expect(store.state).toMatchObject({ source: 'api', config: { name: 'Live' } });
  });

  it('switching module drops an edit; reopening the same one keeps it', async () => {
    const { store } = setup();
    store.show('county');
    await store.edit();
    store.show('county');
    expect(store.state.editing).toBe(true);
    store.show('access');
    expect(store.state).toMatchObject({ active: 'access', editing: false, draft: null });
  });

  it('edit copies the config, then continues the saved server draft', async () => {
    const { store, calls } = setup({ 'GET /config/vanburen/draft': reply(200, { name: 'Drafted' }) });
    const p = store.edit();
    expect(store.state.editing).toBe(true);
    expect(store.state.draft).toEqual({ name: 'Baked County', map: { zoom: 9 } });
    expect(store.state.draft).not.toBe(store.state.config);
    expect(await p).toBe(true);
    expect(store.state.draft).toEqual({ name: 'Drafted' });
    expect(calls[0].headers.Authorization).toBe('Token t');

    const none = setup();
    expect(await none.store.edit()).toBe(false);
    expect(none.store.state.draft.name).toBe('Baked County');
  });

  it('field changes go to the draft, only while editing', async () => {
    const { store } = setup();
    store.setDraft('name', 'Ignored');
    expect(store.state.config.name).toBe('Baked County');
    await store.edit();
    store.setDraft('map.zoom', 12);
    store.addRow('parcelNumber.segments');
    store.removeRow('parcelNumber.segments', 0);
    store.addRow('parcelNumber.segments');
    expect(store.state.draft).toMatchObject({ map: { zoom: 12 }, parcelNumber: { segments: [{ name: '' }] } });
    expect(store.state.config.map.zoom).toBe(9);
    expect(store.current()).toBe(store.state.draft);
    store.cancel();
    expect(store.current()).toBe(store.state.config);
  });

  it('save sends the draft with its author; refusals say why', async () => {
    const { store, calls, auth } = setup({ 'PUT /config/vanburen/draft': [
      reply(200), reply(503), reply(403, { detail: 'no access' }), reply(403), reply(401), reply(401), reply(500), new TypeError('offline'),
    ] });
    await store.edit();
    store.setDraft('name', 'Renamed');
    expect(await store.save()).toEqual({ ok: true, message: 'Draft saved.' });
    expect(calls.at(-1).body).toEqual({ payload: { name: 'Renamed', map: { zoom: 9 } }, author: 'console' });
    expect((await store.save()).message).toMatch(/not yet provisioned/);
    expect((await store.save()).message).toBe('Not allowed: no access');
    expect((await store.save()).message).toBe('Not allowed: this account can’t change this county’s config.');
    expect((await store.save()).message).toBe('Your staff sign-in has expired. Sign in again to save.');
    auth.noteRefused.mockReturnValueOnce(false);   // not signed in to begin with
    expect((await store.save()).message).toBe('Sign in as staff to save: admin auth required.');
    expect((await store.save()).message).toBe('Request failed (HTTP 500).');
    expect((await store.save()).message).toBe('offline');
  });

  it('publish saves, publishes and reloads the config, leaving edit mode', async () => {
    const { store, calls } = setup({
      'PUT /config/vanburen/draft': reply(200),
      'POST /config/vanburen/publish': reply(200, { version: 7 }),
      'GET /config': reply(200, { name: 'Published' }),
    });
    await store.edit();
    expect(await store.publish()).toEqual({ ok: true, message: 'Published version 7.' });
    expect(calls.map((c) => c.key)).toEqual(['GET /config/vanburen/draft', 'PUT /config/vanburen/draft', 'POST /config/vanburen/publish', 'GET /config']);
    expect(calls[2].body).toEqual({ author: 'console', note: 'Published from console' });
    expect(store.state).toMatchObject({ editing: false, draft: null, config: { name: 'Published' } });
  });

  it('publish stops at a refused save and stays in edit mode', async () => {
    const { store, calls } = setup({ 'PUT /config/vanburen/draft': reply(503) });
    await store.edit();
    const res = await store.publish('A note');
    expect(res.ok).toBe(false);
    expect(calls.some((c) => c.key.includes('publish'))).toBe(false);
    expect(store.state.editing).toBe(true);
  });

  it('versions lists them; rollback restores one and reloads the config', async () => {
    const { store, calls } = setup({
      'GET /config/vanburen/versions': [reply(200, { versions: [{ version: 3 }] }), reply(401)],
      'POST /config/vanburen/rollback': reply(200, { version: 8 }),
      'GET /config': reply(200, { name: 'Restored' }),
    });
    expect(await store.versions()).toEqual({ ok: true, message: '', versions: [{ version: 3 }] });
    expect((await store.versions()).ok).toBe(false);
    expect(await store.rollback(3)).toEqual({ ok: true, message: 'Restored v3 as version 8.' });
    expect(calls.find((c) => c.key.includes('rollback')).body).toEqual({ version: 3, author: 'console' });
    expect(store.state.config.name).toBe('Restored');
  });

  it('preview hands the draft to the viewer tab; cancel clears it', async () => {
    const { store, local, open } = setup();
    await store.edit();
    store.setDraft('name', 'Preview');
    expect(store.preview().ok).toBe(true);
    expect(JSON.parse(local.getItem('pv-config-preview')).name).toBe('Preview');
    expect(open).toHaveBeenCalledWith('/demo/', 'pvPreview');
    store.cancel();
    expect(local.getItem('pv-config-preview')).toBeNull();

    open.mockImplementationOnce(() => { throw new Error('blocked'); });
    expect(store.preview()).toEqual({ ok: false, message: 'Could not open preview: blocked' });
  });

  it('ensureDraft starts editing without the Edit button, keeping a draft already there', () => {
    const { store } = setup();
    const d = store.ensureDraft();
    expect(store.state.editing).toBe(true);
    d.manifest = { id: 'm' };
    expect(store.ensureDraft()).toBe(d);
    expect(store.rowsAt('layers.overlays')).toEqual([]);
  });
});

describe('AdminConsole', () => {
  // A module that shows its id and how many times it was created.
  let created = 0;
  const fake = (id) => defineComponent({
    props: ['store'],
    setup: (p) => { created++; return () => h('h1', { 'data-store': String(!!p.store) }, id); },
  });
  function shell({ hash = '', routes } = {}) {
    const s = setup(routes || { 'GET /config': reply(200, { name: 'Live County' }) });
    const modules = ['county', 'styling', 'access'].map((id) => ({ id, label: id.toUpperCase(), icon: '·', component: fake(id) }));
    const listeners = [];
    const auth = { state: { user: null, busy: false, message: '' }, onChange: (fn) => listeners.push(fn), signIn: vi.fn(), signOut: vi.fn() };
    const win = { location: { hash }, history: { replaceState: vi.fn((a, b, h) => { win.location.hash = h; }) } };
    const w = mount(AdminConsole, { props: { store: s.store, auth, modules, win }, attachTo: document.body });
    return { ...s, w, modules, win, signedInOrOut: () => listeners.forEach((fn) => fn()) };
  }

  it('opens the module in the address (else County) in <main> with the store, and keeps the address', async () => {
    const { w, win } = shell({ hash: '#styling' });
    await flushPromises();
    expect(w.get('main').text()).toBe('styling');
    expect(w.get('main h1').attributes('data-store')).toBe('true');
    expect(w.get('[data-mod="styling"]').attributes('aria-current')).toBe('page');
    expect(w.get('[data-mod="styling"]').classes()).toContain('is-active');
    expect(document.activeElement).toBe(w.get('main').element);

    await w.get('[data-mod="access"]').trigger('click');
    expect(win.location.hash).toBe('#access');
    expect(w.get('main').text()).toBe('access');
    expect(w.findAll('[aria-current]')).toHaveLength(1);
    w.unmount();

    const other = shell({ hash: '#nope' });
    await flushPromises();
    expect(other.win.location.hash).toBe('#county');
    expect(other.w.get('main').text()).toBe('county');
    other.w.unmount();
  });

  it('the top bar follows the config; /config answering or a sign-in keeps the open module and its edit', async () => {
    const { w, store, signedInOrOut } = shell();
    expect(w.get('#ac-status').text()).toBe('Read-only preview');
    expect(w.get('#ac-county-select').text()).toBe('Baked County');
    await flushPromises();
    const before = created;
    await store.edit();
    await vi.waitFor(() => expect(w.get('#ac-status').text()).toBe('Live config · read-only'));
    expect(w.get('#ac-county-select').text()).toBe('Live County');
    signedInOrOut();
    await flushPromises();
    expect(store.state.editing).toBe(true);
    expect(w.get('main').text()).toBe('county');
    expect(created).toBe(before);   // not re-created
    w.unmount();
  });

  it('keeps the landmarks, labels and ids the CSS and the e2e suite use', () => {
    const { w } = shell();
    expect(w.get('aside').attributes()).toMatchObject({ role: 'navigation', 'aria-label': 'Admin sections', class: 'ac-side' });
    expect(w.get('#ac-auth').attributes('data-testid')).toBe('ac-auth');
    expect(w.find('#ac-auth #ac-signin').exists()).toBe(true);
    expect(w.get('#ac-county-select').attributes('aria-label')).toBe('Active county');
    expect(w.get('#ac-status').attributes()).toMatchObject({ role: 'status', 'aria-label': 'Config status' });
    expect(w.get('main').attributes()).toMatchObject({ id: 'ac-content', tabindex: '-1' });
    w.unmount();
  });
});

describe('modules', () => {
  it('are the six, in nav order, each a component', () => {
    expect(MODULES.map((m) => m.id)).toEqual(['county', 'intelligence', 'styling', 'data', 'access', 'manifest']);
    expect(MODULES.every((m) => m.component && m.label && m.icon)).toBe(true);
  });
});
