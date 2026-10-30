// Data & Layers as a Vue module (DIC-2389; was admin.js renderData and the layer
// discovery), with the discovery helpers. A real console store runs over a faked API;
// the e2e suite covers the same against the stack (admin-console.spec.js, "data: …",
// "discovery …").
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { availableLayers, discoveryError, loadDiscovered, optionText, overlayFor, titleize } from './discovery.js';
import DataLayers from './modules/DataLayers.vue';
import { createConsoleStore } from './store.js';

const reply = (status, json = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

const CONFIG = {
  layers: {
    tileServer: { provider: 'Martin', url: '/tiles' },
    overlays: [
      { id: 'wetlands', label: 'Wetlands', type: 'WMS', source: 'USFWS', minZoom: 12 },
      { id: 'subs', label: 'Subdivisions', type: 'vector', source: 'subs_tiles', minZoom: 12, default: true },
      { id: 'roads', label: 'Roads', type: 'vector', source: '', minZoom: 0 },
    ],
    dataSources: [{ id: 'parcels', label: 'Parcel geometry', source: 'geo.parcels' }],
  },
};
const DISCOVERED = [
  { id: 'drain_lines', source: 'drain_lines_tiles', sourceLayer: 'drain_lines', geomType: 'line', rowCount: 1234, dbSource: 'geo.drain_lines', fields: ['name'] },
  { id: 'subs', source: 'subs_tiles', geomType: 'polygon' },
  { id: 'parks', source: 'parks_tiles', registered: true },
];

function setup({ discovered = { layers: DISCOVERED }, routes = {}, config = CONFIG } = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, opts = {}) => {
    const key = (opts.method || 'GET') + ' ' + url.replace('/api', '');
    calls.push({ key, body: opts.body ? JSON.parse(opts.body) : undefined });
    return routes[key] || reply(404);
  });
  const auth = reactive({ user: { token: 't' } });
  const store = createConsoleStore({
    fetch, apiBase: () => '/api',
    auth: { headers: () => ({}), noteRefused: () => false, has: () => !!auth.user },
    countyKey: 'test', author: 'console', fallback: structuredClone(config),
    local: () => ({ setItem() {}, removeItem() {} }), open: () => {},
  });
  store.show('data');
  const discover = vi.fn(async () => discovered);
  return { store, calls, auth, discover, w: mount(DataLayers, { props: { store, discover } }) };
}

const card = (w, title) => w.findAll('.ac-card').find((c) => c.find('h2').exists() && c.get('h2').text() === title);
const rows = (c) => c.findAll('tbody tr').map((r) => r.findAll('td').map((td) => td.text()));
const btn = (w, name) => w.findAll('button').find((b) => b.text() === name);
const field = (w, path) => w.get(`[data-path="${path}"]`);

describe('discovery helpers', () => {
  it('names, filters and describes discovered layers', () => {
    expect(titleize('plss_sections')).toBe('PLSS Sections');
    expect(availableLayers(DISCOVERED, CONFIG).map((d) => d.id)).toEqual(['drain_lines']);
    expect(optionText(DISCOVERED[0])).toBe('Drain Lines — line, 1,234 features');
    expect(optionText({ id: 'x' })).toBe('X — —');
    expect(overlayFor({ id: 'p', source: 'p_tiles' })).toMatchObject({ label: 'P', type: 'vector', geomType: 'polygon', minZoom: 12, default: false, fields: [] });
    expect(discoveryError('HTTP 500')).toBe('Couldn’t reach the tile server / DB (HTTP 500).');
  });

  it('asks only when signed in, with the token; a refused token signs out', async () => {
    const auth = { has: () => true, headers: () => ({ Authorization: 'Token t' }), noteRefused: vi.fn() };
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply(200, { layers: [1] }))
      .mockResolvedValueOnce(reply(401)).mockResolvedValueOnce(reply(403)).mockResolvedValueOnce(reply(500))
      .mockRejectedValueOnce(new TypeError('offline'));
    const go = () => loadDiscovered({ fetch, apiBase: () => '/api', auth });
    expect(await go()).toEqual({ layers: [1] });
    expect(fetch).toHaveBeenCalledWith('/api/admin/discover/layers', { cache: 'no-cache', headers: { Authorization: 'Token t' } });
    expect(await go()).toEqual({ error: 'sign-in' });
    expect(auth.noteRefused).toHaveBeenCalledWith(401);
    expect(await go()).toEqual({ error: 'staff' });
    expect(await go()).toEqual({ error: 'HTTP 500' });
    expect(await go()).toEqual({ error: 'offline' });
    expect(await loadDiscovered({ fetch, apiBase: () => '/api', auth: { has: () => false } })).toEqual({ error: 'sign-in' });
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});

describe('DataLayers', () => {
  it('shows the tile server, the PostGIS layers, the overlays and the sources', async () => {
    const { w } = setup();
    await flushPromises();
    expect(w.get('h1').text()).toBe('Data & Layers');
    expect(card(w, 'PostGIS layers').get('.ac-card-note').text()).toBe('2 vector layer(s)');
    expect(rows(card(w, 'PostGIS layers'))).toEqual([['Subdivisions', 'subs_tiles', 'z12+', 'on'], ['Roads', '—', 'all', '']]);
    expect(rows(card(w, 'External overlays'))).toEqual([['Wetlands', 'WMS', 'USFWS', 'z12+']]);
    expect(rows(card(w, 'Data sources'))).toEqual([['Parcel geometry', 'geo.parcels']]);
    expect(w.findAll('input')).toHaveLength(0);
  });

  it('no overlays: no External overlays card, and the PostGIS table says so', async () => {
    const { w } = setup({ config: { layers: {} } });
    await flushPromises();
    expect(card(w, 'External overlays')).toBeUndefined();
    expect(card(w, 'PostGIS layers').get('tbody').text()).toBe('No PostGIS layers yet.');
    expect(card(w, 'Data sources').get('tbody').text()).toBe('No data sources defined.');
  });

  it('edits each PostGIS row by its index in the overlays, with its type; rows add and remove', async () => {
    const { store, w } = setup();
    await btn(w, 'Edit layers').trigger('click');
    expect(field(w, 'layers.overlays.1.label').element.value).toBe('Subdivisions');
    expect(field(w, 'layers.overlays.1.minZoom').attributes('type')).toBe('number');
    await field(w, 'layers.overlays.1.minZoom').setValue('9');
    await field(w, 'layers.overlays.2.default').setValue(true);
    await field(w, 'layers.tileServer.url').setValue('/t2');
    await btn(w, '+ Add PostGIS layer').trigger('click');
    expect(rows(card(w, 'PostGIS layers'))).toHaveLength(3);
    await w.get('[data-remove="layers.overlays"][data-index="1"]').trigger('click');
    await btn(w, '+ Add data source').trigger('click');
    await field(w, 'layers.dataSources.1.source').setValue('geo.new');
    const L = store.state.draft.layers;
    expect(L.tileServer.url).toBe('/t2');
    expect(L.overlays.map((o) => o.id)).toEqual(['wetlands', 'roads', '']);
    expect(L.overlays[1].default).toBe(true);
    expect(L.dataSources[1]).toEqual({ id: '', label: '', source: 'geo.new' });
    expect(card(w, 'External overlays').findAll('input')).toHaveLength(0);
  });

  it('discovery lists what is left to add; picking shows it; Add puts it in the draft, entering edit mode', async () => {
    const { store, w } = setup();
    await flushPromises();
    const sel = w.get('#ac-pg-pick');
    expect(sel.element.disabled).toBe(false);
    expect(sel.findAll('option').map((o) => o.text())).toEqual(['Select a layer to add…', 'Drain Lines — line, 1,234 features']);

    await btn(w, 'Add layer').trigger('click');
    expect(w.get('.ac-flash-err').text()).toBe('Pick a layer to add first.');

    await sel.setValue('drain_lines_tiles');
    expect(w.findAll('#ac-pg-pick-meta dd').map((d) => d.text())).toEqual(['line', '1,234', 'geo.drain_lines', 'drain_lines_tiles']);
    await btn(w, 'Add layer').trigger('click');
    expect(store.state.editing).toBe(true);
    expect(store.state.draft.layers.overlays.at(-1)).toMatchObject({ id: 'drain_lines', label: 'Drain Lines', source: 'drain_lines_tiles', geomType: 'line' });
    expect(store.state.draft.styling.layers.drain_lines.paint.light.fill).toBe('#1F5E80');
    expect(store.state.config.layers.overlays).toHaveLength(3);
    expect(w.get('.ac-flash-ok').text()).toBe('Added “Drain Lines”. Publish to make it live in the viewer.');
    expect(sel.findAll('option').map((o) => o.text())).toEqual(['All available layers added']);
    expect(field(w, 'layers.overlays.3.label').element.value).toBe('Drain Lines');
  });

  it('discovery says why it has nothing: signed out, not staff, down; and asks again on sign-in', async () => {
    const out = setup({ discovered: { error: 'sign-in' } });
    await flushPromises();
    expect(out.w.get('#ac-pg-pick').text()).toBe('Discovery needs a staff sign-in');
    expect(out.w.get('#ac-pg-pick-meta').text()).toBe('Layer discovery needs a staff sign-in.');
    out.auth.user = null;
    await flushPromises();
    expect(out.discover).toHaveBeenCalledTimes(2);

    const staff = setup({ discovered: { error: 'staff' } });
    await flushPromises();
    expect(staff.w.get('#ac-pg-pick').text()).toBe('Discovery unavailable');
    expect(staff.w.get('#ac-pg-pick').element.disabled).toBe(true);
    expect(staff.w.get('#ac-pg-pick-meta').text()).toMatch(/isn’t allowed for this account/);

    const loading = setup({ discovered: new Promise(() => {}) });
    loading.discover.mockImplementation(() => new Promise(() => {}));
    expect(loading.w.get('#ac-pg-pick').text()).toBe('Loading available layers…');
  });
});
