// Compare (DIC-589) as a Vue island (DIC-2389): the table model, the store and the
// components, without a page. The e2e suite (compare.spec.js, data-access.spec.js) checks
// it in the real viewer.
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import compareCore from '../../../engine/capabilities/cohort-analyze.core.js';
import CompareRoot from './CompareRoot.vue';
import { createCompareStore } from './store.js';
import { buildTable, formatValue } from './table.js';

const feature = (id, props) => ({ id, properties: { pin: `P-${id}`, ...props } });
const COHORT = {
  selector: { type: 'explicit', ids: [1, 2] },
  features: [
    feature(1, { owner_name: 'Smith', gis_acres: 2, assessed_value: 100000, prop_class: '401' }),
    feature(2, { owner_name: 'Smith', gis_acres: 4, assessed_value: 100000, prop_class: '<b>402</b>' }),
  ],
};

function makeStore({ data = COHORT, ok = true, parcel = null, caps = true } = {}) {
  const toast = vi.fn();
  const fetch = vi.fn(async () => ({ ok, json: async () => structuredClone(data) }));
  const viewer = {
    apiBase: () => '/api',
    capEnabled: () => caps,
    countyConfig: () => ({ labels: { propClass: { 401: 'Residential' } } }),
    selectedParcel: () => parcel,
    access: () => null,
    cohortCore: () => compareCore,
  };
  return { store: createCompareStore({ viewer, toast, fetch }), toast, fetch };
}

describe('formatValue', () => {
  it('formats money, acres, codes and blanks', () => {
    expect(formatValue('assessed_value', 1234.6)).toBe('$1,235');
    expect(formatValue('gis_acres', '2.5')).toBe('2.50 ac');
    expect(formatValue('prop_class', '401', { propClass: { 401: 'Residential' } })).toBe('401 – Residential');
    expect(formatValue('owner_name', null)).toBe('—');
    expect(formatValue('owner_name', '')).toBe('—');
  });
});

describe('buildTable', () => {
  it('derives $/acre, flags differing rows and marks withheld cells', () => {
    const t = buildTable(
      { ...COHORT, features: [...COHORT.features, feature(3, { gis_acres: null, withheld: true })] },
      { core: compareCore.core, isWithheld: (p) => !!p.withheld },
    );
    expect(t.columns.map((c) => c.label)).toEqual(['P-1', 'P-2', 'P-3']);
    const row = (field) => t.rows.find((r) => r.field === field);
    expect(row('av_per_acre').cells.map((c) => c.text)).toEqual(['$50,000', '$25,000', 'Withheld']);
    expect(row('gis_acres').differs).toBe(true);
    expect(row('owner_name').cells[2]).toEqual({ text: 'Withheld', withheld: true });
  });
});

describe('the compare store', () => {
  it('holds up to five parcels, once each', () => {
    const { store, toast } = makeStore();
    for (let id = 1; id <= 6; id++) store.add(id, `P-${id}`);
    store.add(1, 'P-1');
    expect(store.state.set.map((p) => p.id)).toEqual([1, 2, 3, 4, 5]);
    expect(toast).toHaveBeenCalledWith('Compare holds up to 5 parcels.');
  });

  it('removes a parcel added by PIN, by PIN or by the id learned from /cohort', async () => {
    const { store } = makeStore();
    await store.open(['P-1', 'P-2', 'P-9']);
    expect(store.state.set.map((p) => p.id)).toEqual([1, 2, null]);
    store.remove(1);
    store.remove('P-9');
    expect(store.state.set).toEqual([{ id: 2, pin: 'P-2' }]);
  });

  it('asks for a selected parcel before adding the current one', () => {
    const { store, toast } = makeStore();
    store.addCurrent();
    expect(toast).toHaveBeenCalledWith('Select a parcel first, then add it to Compare.');
    expect(store.state.set).toEqual([]);
  });

  it('says so when /cohort fails, and opens nothing', async () => {
    const { store, toast } = makeStore({ ok: false });
    await store.open([1, 2]);
    expect(toast).toHaveBeenCalledWith('Couldn’t load those parcels.');
    expect(store.state.open).toBe(false);
  });

  it('does nothing when the compare capability is off', async () => {
    const { store, fetch } = makeStore({ caps: false });
    store.add(1, 'P-1');
    await store.open([1, 2]);
    expect(store.state.set.length).toBe(2);      // open() sets the list; show() is gated
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the components', () => {
  it('the tray shows a chip per parcel, and Compare once there are two', async () => {
    const { store } = makeStore();
    const w = mount(CompareRoot, { props: { store }, attachTo: document.body });
    const tray = w.get('[data-testid="pv-compare-tray"]');
    expect(tray.attributes('hidden')).toBeDefined();
    store.add(1, 'P-1');
    await nextTick();
    expect(tray.attributes('hidden')).toBeUndefined();
    expect(w.get('.pv-compare-go').attributes('disabled')).toBeDefined();
    store.add(2, 'P-2');
    await nextTick();
    expect(w.get('.pv-compare-go').text()).toBe('Compare (2)');
    await w.findAll('[data-testid="pv-compare-chip"] button')[0].trigger('click');
    expect(store.state.set.map((p) => p.pin)).toEqual(['P-2']);
    w.unmount();
  });

  it('the table renders values as text and hands the dialog to PV_DIALOG', async () => {
    const { store } = makeStore();
    const dialog = { opened: vi.fn(), closed: vi.fn() };
    const w = mount(CompareRoot, { props: { store, dialog }, attachTo: document.body });
    await store.open([1, 2]);
    await nextTick();
    const table = w.get('[role="dialog"][aria-label="Compare parcels"]');
    expect(table.html()).toContain('&lt;b&gt;402&lt;/b&gt;');   // escaped, not markup
    expect(table.findAll('.pv-cmp-differs').length).toBeGreaterThan(0);
    expect(dialog.opened).toHaveBeenCalledTimes(1);
    await w.get('[aria-label="Close"]').trigger('click');
    await nextTick();
    expect(dialog.closed).toHaveBeenCalledTimes(1);
    expect(w.get('.pv-compare-overlay').attributes('hidden')).toBeDefined();
    w.unmount();
  });

  it("a column's × re-shows the rest, or closes when fewer than two remain", async () => {
    const { store, fetch } = makeStore();
    mount(CompareRoot, { props: { store } });
    await store.open([1, 2]);
    await store.removeColumn(1);
    expect(store.state.open).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
