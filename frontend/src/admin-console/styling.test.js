// Styling as a Vue module (DIC-2389; was admin.js renderStyling), with the ColorField and
// DraftSelect it edits with. A real console store runs over a faked API; the e2e suite
// covers the same against a stubbed /config (admin-console.spec.js, "styling: …").
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ColorField from './ColorField.vue';
import DraftSelect from './DraftSelect.vue';
import Styling from './modules/Styling.vue';
import { createConsoleStore } from './store.js';

const CONFIG = {
  layers: { overlays: [
    { id: 'roads', type: 'vector', geomType: 'line', fields: ['name'] },
    { id: 'wells', type: 'vector', geomType: 'point' },
  ] },
  styling: {
    colorScheme: 'harvest', theme: 'light', basemap: 'parcels',
    schemes: [{ id: 'harvest', label: 'Harvest', accent: '#a3473b' }, { id: 'lake', label: 'Lake' }],
    labels: { defaultField: 'owner', fields: ['owner', 'pin'], zoom: { largeParcels: 13 } },
    layers: {
      parcels: { label: 'Parcels', paint: { light: { fill: '#f5f0e8' } },
        choropleth: { enabled: false, mode: 'categorical', fields: ['prop_class'], categories: [{ value: '4', label: 'Res', color: '#e8c07d' }] } },
      roads: { label: 'Roads', line: { width: 2 }, labels: { enabled: true, field: 'name', size: 11 } },
      wells: { point: { radius: 4 } },
      // No overlay: geometry from its style block.
      trails: { line: { width: 1 } },
    },
  },
};

function setup(config = CONFIG) {
  const store = createConsoleStore({
    fetch: vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    apiBase: () => '/api', auth: { headers: () => ({}), noteRefused: () => false },
    countyKey: 'test', author: 'console', fallback: structuredClone(config),
    local: () => ({ setItem() {}, removeItem() {} }), open: () => {},
  });
  store.show('styling');
  return { store, w: mount(Styling, { props: { store } }) };
}

const card = (w, title) => w.findAll('.ac-card').find((c) => c.find('h2').exists() && c.get('h2').text() === title);
const dd = (scope, label) => scope.findAll('dt').find((dt) => dt.text() === label).element.nextElementSibling.textContent.replace(/\s+/g, ' ').trim();
const btn = (w, name) => w.findAll('button').find((b) => b.text() === name);
const field = (w, path) => w.get(`[data-path="${path}"]`);
const pick = (w) => w.get('[data-style-layer]');

describe('Styling', () => {
  it('shows the schemes with the default, the theme, and the first layer by its geometry', () => {
    const { w } = setup();
    expect(w.findAll('.ac-scheme').map((s) => s.text())).toEqual(['Harvest default', 'Lake']);
    expect(w.get('.ac-scheme.is-active').element.tagName).toBe('DIV');
    expect(dd(card(w, 'Theme & basemap'), 'Default theme')).toBe('light');
    expect(pick(w).findAll('option').map((o) => o.text())).toEqual(['Parcels', 'Roads', 'wells', 'trails']);
    expect(card(w, 'Layer styling').get('.ac-card-note').text()).toBe('fill, stroke & choropleth');
    expect(dd(card(w, 'Layer styling'), 'Light — fill')).toBe('#f5f0e8');
    expect(dd(card(w, 'Layer styling'), 'Dark — fill')).toBe('—');
    expect(card(w, 'Choropleth').text()).toContain('Off — Parcels uses the solid paint above.');
    expect(card(w, 'Categories')).toBeUndefined();   // off: no ramp
    expect(dd(card(w, 'Parcel labels'), 'Zoom — large / small')).toBe('large 13+, small —+');
  });

  it('the picker shows each layer by its geometry: line, point, and by its style block', async () => {
    const { w } = setup();
    await pick(w).setValue('roads');
    expect(card(w, 'Layer styling').get('.ac-card-note').text()).toBe('line — casing, dash & glow');
    expect(dd(card(w, 'Layer styling'), 'Width')).toBe('2 px');
    expect(dd(card(w, 'Layer styling'), 'Dash')).toBe('solid');
    expect(card(w, 'Choropleth')).toBeUndefined();
    expect(card(w, 'Labels').get('.ac-card-note').text()).toBe('text along the line');
    expect(dd(card(w, 'Labels'), 'Size · min zoom')).toBe('11px · z0+');
    await pick(w).setValue('wells');
    expect(dd(card(w, 'Layer styling'), 'Radius')).toBe('4 px');
    expect(card(w, 'Labels').text()).toContain('no label-able attributes');
    await pick(w).setValue('trails');
    expect(card(w, 'Layer styling').get('.ac-card-note').text()).toBe('line — casing, dash & glow');
  });

  it('editing: the scheme chips set the default; the paint and the choropleth edit the draft', async () => {
    const { store, w } = setup();
    await btn(w, 'Edit styling').trigger('click');
    await w.get('[data-scheme-pick="lake"]').trigger('click');
    expect(w.get('.ac-scheme.is-active').text()).toBe('Lake default');
    await field(w, 'styling.theme').setValue('dark');
    await field(w, 'styling.layers.parcels.paint.light.fill').setValue('#112233');
    expect(dd(card(w, 'Layer styling'), 'Light — fill')).toBe('#112233');
    await field(w, 'styling.layers.parcels.choropleth.enabled').setValue(true);
    expect(card(w, 'Categories').findAll('tbody tr')).toHaveLength(1);
    await btn(w, '+ Add category').trigger('click');
    await field(w, 'styling.layers.parcels.choropleth.categories.1.value').setValue('2');
    await field(w, 'styling.layers.parcels.choropleth.mode').setValue('graduated');
    expect(card(w, 'Categories')).toBeUndefined();
    expect(card(w, 'Color stops').get('tbody').text()).toBe('No stops yet — add one below.');
    await btn(w, '+ Add stop').trigger('click');
    await field(w, 'styling.layers.parcels.choropleth.stops.0.min').setValue('5');
    const S = store.state.draft.styling;
    expect(S).toMatchObject({ colorScheme: 'lake', theme: 'dark' });
    expect(S.layers.parcels.choropleth).toMatchObject({ enabled: true, mode: 'graduated', stops: [{ min: 5, color: '#888888' }] });
    expect(S.layers.parcels.choropleth.categories[1]).toEqual({ value: '2', label: '', color: '#888888' });
    expect(store.state.config.styling.colorScheme).toBe('harvest');
  });

  it('editing a line layer and its labels; the picker keeps the edits', async () => {
    const { store, w } = setup();
    await btn(w, 'Edit styling').trigger('click');
    await pick(w).setValue('roads');
    await field(w, 'styling.layers.roads.line.dash').setValue('dotted');
    await field(w, 'styling.layers.roads.line.width').setValue('3');
    await field(w, 'styling.layers.roads.labels.enabled').setValue(false);
    expect(field(w, 'styling.layers.roads.labels.field').findAll('option').map((o) => o.text())).toEqual(['(none)', 'name']);
    await pick(w).setValue('parcels');
    await pick(w).setValue('roads');
    expect(field(w, 'styling.layers.roads.line.width').element.value).toBe('3');
    expect(store.state.draft.styling.layers.roads).toMatchObject({ line: { dash: 'dotted', width: 3 }, labels: { enabled: false } });
  });

  it('without styling, or without layers, says so', () => {
    expect(setup({}).w.text()).toContain('No styling config in the manifest yet.');
    const { w } = setup({ styling: { schemes: [] } });
    expect(card(w, 'Layer styling').text()).toContain('No stylable layers in the manifest yet.');
    expect(card(w, 'Labels')).toBeUndefined();
  });
});

describe('ColorField and DraftSelect', () => {
  it('a colour writes its hex; a select writes the picked value, labelled options too', async () => {
    const store = { setDraft: vi.fn() };
    const c = mount(ColorField, { props: { store, path: 'p.c', value: null, editing: true } });
    expect(c.get('input').element.value).toBe('#000000');
    expect(c.get('code').text()).toBe('—');
    await c.get('input').setValue('#abcdef');
    expect(store.setDraft).toHaveBeenCalledWith('p.c', '#abcdef');
    const s = mount(DraftSelect, { props: { store, path: 'p.s', value: '', options: [{ v: '', l: '(none)' }, 'a'] } });
    expect(s.findAll('option').map((o) => [o.element.value, o.text()])).toEqual([['', '(none)'], ['a', 'a']]);
    expect(s.element.value).toBe('');
    await s.find('select').setValue('a');
    expect(store.setDraft).toHaveBeenLastCalledWith('p.s', 'a');
  });
});
