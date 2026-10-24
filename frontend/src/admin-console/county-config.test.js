// County Configuration as a Vue module (DIC-2389; was admin.js renderCounty), and the
// DraftField it edits with. A real console store runs over a faked API; the e2e suite
// covers the same against the stack (admin-console.spec.js, "county: …").
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import DraftField from './DraftField.vue';
import CountyConfig from './modules/CountyConfig.vue';
import { createConsoleStore } from './store.js';

const reply = (status, json = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

const CONFIG = {
  name: 'Test County', state: 'MI', forms: { dataRequest: 'https://forms.test' },
  map: { center: [-86, 42.2], zoom: 9, extent: [[-86.3, 42], [-85.7, 42.4]] },
  endpoints: { mapBuddy: '/mb' }, integrations: {},
  parcelNumber: { separator: '-', example: '80-01-001', intro: 'Reads left to right.',
    segments: [{ name: 'County', description: 'State code' }, { name: 'Unit', description: '' }] },
  labels: { propClass: { 401: 'Residential', 201: 'Commercial' }, schoolDist: { 80010: 'Bangor' } },
};

function setup(routes = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, opts = {}) => {
    const key = (opts.method || 'GET') + ' ' + url.replace('/api', '');
    calls.push({ key, body: opts.body ? JSON.parse(opts.body) : undefined });
    return routes[key] || reply(404);
  });
  const store = createConsoleStore({
    fetch, apiBase: () => '/api', auth: { headers: () => ({}), noteRefused: () => false },
    countyKey: 'test', author: 'console', fallback: structuredClone(CONFIG),
    local: () => ({ setItem() {}, removeItem() {} }), open: () => {},
  });
  store.show('county');
  return { store, calls, w: mount(CountyConfig, { props: { store } }) };
}

const dd = (w, label) => w.findAll('dt').find((dt) => dt.text() === label).element.nextElementSibling;
const btn = (w, name) => w.findAll('button').find((b) => b.text() === name);
const field = (w, path) => w.get(`[data-path="${path}"]`);

describe('CountyConfig', () => {
  it('shows each field; JSON as code; unset as a dash', () => {
    const { w } = setup();
    expect(w.get('h1').text()).toBe('County Configuration');
    expect(dd(w, 'Name').textContent).toBe('Test County');
    expect(dd(w, 'Center [lng, lat]').innerHTML).toBe('<code>[-86,42.2]</code>');
    expect(dd(w, 'Default zoom').textContent).toBe('9');
    expect(dd(w, 'Google Maps Embed key').textContent).toBe('—');
    expect(dd(w, 'Separator').textContent).toBe('-');
    const rows = w.findAll('.ac-table tbody tr').map((r) => r.findAll('td').map((td) => td.text()));
    expect(rows).toEqual([['1', 'County', 'State code'], ['2', 'Unit', '—']]);
    expect(w.findAll('input')).toHaveLength(0);
    expect(w.get('.ac-banner').text()).toContain('not reachable — showing the baked county-config.js fallback.');
  });

  it('the lookups open one at a time, sorted by code, and close again', async () => {
    const { w } = setup();
    expect(dd(w, 'Property classes').textContent.replace(/\s+/g, ' ').trim()).toBe('2 codes View');
    await w.get('[data-lookup="propClass"]').trigger('click');
    expect(w.get('[data-lookup="propClass"]').text()).toBe('Hide');
    expect(w.get('[data-lookup="propClass"]').attributes('aria-expanded')).toBe('true');
    expect(w.findAll('#ac-lookup-out tbody tr').map((r) => r.text())).toEqual(['201Commercial', '401Residential']);
    await w.get('[data-lookup="schoolDist"]').trigger('click');
    expect(w.get('[data-lookup="propClass"]').text()).toBe('View');
    expect(w.findAll('#ac-lookup-out tbody tr').map((r) => r.text())).toEqual(['80010Bangor']);
    await w.get('[data-lookup="schoolDist"]').trigger('click');
    expect(w.find('#ac-lookup-out table').exists()).toBe(false);
  });

  it('edits every field on the draft with its type; bad JSON is marked and ignored', async () => {
    const { store, w } = setup();
    await btn(w, 'Edit configuration').trigger('click');
    expect(w.get('.ac-banner-edit').text()).toContain('Editing a draft.');
    expect(field(w, 'map.center').element.value).toBe('[-86,42.2]');
    await field(w, 'name').setValue('Renamed');
    await field(w, 'map.zoom').setValue('11');
    await field(w, 'map.center').setValue('[-85, 42]');
    await field(w, 'map.extent').setValue('[oops');
    expect(field(w, 'map.extent').classes()).toContain('ac-input-err');
    await field(w, 'map.extent').setValue('[[0, 0], [1, 1]]');
    expect(field(w, 'map.extent').classes()).not.toContain('ac-input-err');
    expect(store.state.draft).toMatchObject({ name: 'Renamed', map: { zoom: 11, center: [-85, 42], extent: [[0, 0], [1, 1]] } });
    await field(w, 'map.zoom').setValue('');
    expect(store.state.draft.map.zoom).toBeNull();
    await field(w, 'map.zoom').setValue('abc');
    expect(store.state.draft.map.zoom).toBeNull();
    expect(store.state.config.name).toBe('Test County');
  });

  it('segments: add, edit and remove rows; an empty list says so', async () => {
    const { store, w } = setup();
    await btn(w, 'Edit configuration').trigger('click');
    await btn(w, '+ Add segment').trigger('click');
    expect(w.findAll('tbody tr')).toHaveLength(3);
    await field(w, 'parcelNumber.segments.2.name').setValue('Check');
    await w.get('[data-remove="parcelNumber.segments"][data-index="0"]').trigger('click');
    await w.get('[data-remove="parcelNumber.segments"][data-index="0"]').trigger('click');
    expect(store.state.draft.parcelNumber.segments).toEqual([{ name: 'Check', description: '' }]);
    expect(field(w, 'parcelNumber.segments.0.name').element.value).toBe('Check');
    await w.get('[data-remove="parcelNumber.segments"][data-index="0"]').trigger('click');
    expect(w.get('tbody').text()).toBe('No segments defined — add one below.');
    expect(w.get('tbody td').attributes('colspan')).toBe('4');
  });

  it('Save sends the edited draft; the lookups note says they are edited via the API', async () => {
    const { w, calls } = setup({ 'PUT /config/test/draft': reply(200) });
    await btn(w, 'Edit configuration').trigger('click');
    expect(w.text()).toContain('edit via API for now');
    await field(w, 'state').setValue('IN');
    await btn(w, 'Save draft').trigger('click');
    await flushPromises();
    expect(calls.at(-1).body.payload.state).toBe('IN');
    expect(w.get('.ac-flash-ok').text()).toBe('Draft saved.');
  });
});

describe('DraftField', () => {
  it('a checkbox writes a boolean; other attributes reach the input', async () => {
    const store = { setDraft: vi.fn() };
    const box = mount(DraftField, { props: { store, path: 'a.on', type: 'bool', value: true } });
    expect(box.element.checked).toBe(true);
    await box.find('input').setValue(false);
    expect(store.setDraft).toHaveBeenCalledWith('a.on', false);
    const txt = mount(DraftField, { props: { store, path: 'a.t', value: null }, attrs: { class: 'ac-input-sm', placeholder: 'x' } });
    expect(txt.element.value).toBe('');
    expect(txt.classes()).toEqual(['ac-input', 'ac-input-sm']);
    expect(txt.attributes()).toMatchObject({ placeholder: 'x', 'data-path': 'a.t', 'data-type': 'str' });
  });
});

describe('store rev', () => {
  it('counts the draft changes while editing, and only then', async () => {
    const { store } = setup();
    store.setDraft('name', 'x');
    expect(store.state.rev).toBe(0);
    await store.edit();
    store.setDraft('name', 'x');
    store.addRow('parcelNumber.segments');
    store.removeRow('parcelNumber.segments', 0);
    expect(store.state.rev).toBe(3);
  });
});
