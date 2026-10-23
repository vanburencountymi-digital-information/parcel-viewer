// The Selection Tools pane (DIC-2389): filter, CSV, the store against a fake map side,
// and the component. The e2e suite (select-tools.spec.js, map-controls.spec.js) checks it
// against the real map.
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import * as turf from '@turf/turf';
import { csvCell, selectionCsv } from './csv.js';
import { filterFields, matchParcels } from './filter.js';
import SelectTools from './SelectTools.vue';
import { createSelectToolsStore } from './store.js';

// Unit squares along the equator, 0.001° apart (about 111 m), so a buffer has room to
// reach some and not others.
const square = (i) => ({
  type: 'Feature',
  properties: { pin: `P-${i}`, gis_acres: String(i), owner_name: i % 2 ? 'Smith' : 'Jones' },
  geometry: {
    type: 'Polygon',
    coordinates: [[[i * 0.001, 0], [i * 0.001 + 0.0005, 0], [i * 0.001 + 0.0005, 0.0005], [i * 0.001, 0.0005], [i * 0.001, 0]]],
  },
});
const PARCELS = [1, 2, 3, 4, 5, 6].map(square);

function fakeMap({ active = null } = {}) {
  const selected = new Map();
  return {
    selected,
    parcels: () => PARCELS,
    selectionSize: () => selected.size,
    selectedRecords: () => [...selected.values()],
    activeParcel: () => active,
    add: vi.fn((fs) => fs.filter((x) => !selected.has(x.properties.pin) && selected.set(x.properties.pin, x.properties)).length),
    remove: vi.fn((pins) => pins.filter((p) => selected.delete(p)).length),
    clear: vi.fn(() => selected.clear()),
    setTool: vi.fn(),
    setBufferSeed: vi.fn(),
    setBufferPreview: vi.fn(),
    notify: vi.fn(),
  };
}

// Runs the 300 ms preview debounce at once.
const timers = { setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {} };

function makeStore(opts = {}) {
  const map = fakeMap(opts);
  const download = vi.fn();
  const store = createSelectToolsStore({ map, turf, download, timers, isWithheld: (p) => !!p.withheld });
  return { store, map, download };
}

describe('filter', () => {
  it('offers the index fields, underscores as spaces', () => {
    expect(filterFields(PARCELS).map((x) => x.label)).toEqual(['pin', 'gis acres', 'owner name']);
    expect(filterFields([])).toEqual([]);
  });

  it('matches text without case and numbers as numbers', () => {
    const pins = (q) => matchParcels(PARCELS, q).map((x) => x.properties.pin);
    expect(pins({ field: 'owner_name', op: 'eq', value: 'SMITH' })).toEqual(['P-1', 'P-3', 'P-5']);
    expect(pins({ field: 'owner_name', op: 'contains', value: 'on' })).toEqual(['P-2', 'P-4', 'P-6']);
    expect(pins({ field: 'gis_acres', op: 'gt', value: '4' })).toEqual(['P-5', 'P-6']);
    expect(pins({ field: 'gis_acres', op: 'lt', value: 'x' })).toEqual([]);
    expect(pins({ field: '', op: 'eq', value: '1' })).toEqual([]);
  });
});

describe('csv', () => {
  it('neutralises formulas and quotes awkward text', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell('a,b\r\nc')).toBe('"a,b\r\nc"');
    expect(csvCell(null)).toBe('');
  });

  it('has a column for every property any row has', () => {
    expect(selectionCsv([{ pin: 'A' }, { pin: 'B', note: 'x' }])).toBe('pin,note\nA,\nB,x');
  });
});

describe('the store', () => {
  it('arms one tool at a time; arming it again exits', () => {
    const { store, map } = makeStore();
    store.setTool('box');
    store.setTool('box');
    expect(store.state.tool).toBe(null);
    expect(map.setTool.mock.calls.map((c) => c[0])).toEqual(['box', null]);
    store.setTool('filter');
    expect(store.escape()).toBe(false);       // Esc leaves the filter open
    store.setTool('lasso');
    expect(store.escape()).toBe(true);
    expect(store.state.tool).toBe(null);
  });

  it('filter: counts matches as you type, then says what Add and Remove did', async () => {
    const { store, map } = makeStore();
    Object.assign(store.state.filter, { field: 'owner_name', op: 'eq', value: 'smith' });
    await nextTick();
    expect(store.state.filter.note).toBe('3 parcels match');
    store.addFilterMatches();
    expect(store.state.filter.note).toBe('Added 3 parcels');
    store.state.filter.value = 'jones';
    await nextTick();
    store.removeFilterMatches();
    expect(store.state.filter.note).toBe('None in selection');
    expect(map.selected.size).toBe(3);
  });

  it('filter: Remove drops the selected matches even after the viewport index moved on', () => {
    const { store, map } = makeStore();
    Object.assign(store.state.filter, { field: 'gis_acres', op: 'gt', value: '2' });
    store.addFilterMatches();
    expect(map.selected.size).toBe(4);
    // Add panned to its first parcel; the index now holds only the parcels around it.
    map.parcels = () => PARCELS.slice(0, 3);
    store.removeFilterMatches();
    expect(store.state.filter.note).toBe('Removed 4 parcels');
    expect(map.selected.size).toBe(0);
  });

  it('buffer: seeds from the parcel on screen, previews, and adds within the distance', async () => {
    const { store, map } = makeStore({ active: PARCELS[0] });
    store.setTool('buffer');
    expect(store.state.buffer.seedPin).toBe('P-1');
    expect(map.setBufferSeed).toHaveBeenLastCalledWith('P-1');
    store.state.buffer.distance = '250';      // feet (76 m): reaches P-2 (55 m away), not P-3
    await nextTick();
    expect(store.state.buffer.note).toBe('2 parcels in buffer');
    const [, previewPins] = map.setBufferPreview.mock.calls.at(-1);
    expect(previewPins).toEqual(['P-2']);     // the seed has its own highlight
    store.addBufferMatches();
    expect([...map.selected.keys()]).toEqual(['P-1', 'P-2']);
    expect(store.state.tool).toBe(null);      // adding exits the tool and clears the seed
    expect(store.state.buffer.seedPin).toBe(null);
    expect(map.setBufferPreview).toHaveBeenLastCalledWith(null, []);
  });

  it('buffer: leaves the seed out when "Include seed" is off', async () => {
    const { store, map } = makeStore({ active: PARCELS[0] });
    store.setTool('buffer');
    Object.assign(store.state.buffer, { distance: '250', includeSeed: false });
    await nextTick();
    expect(store.state.buffer.note).toBe('1 parcel in buffer');
    store.addBufferMatches();
    expect([...map.selected.keys()]).toEqual(['P-2']);
  });

  it('buffer: recounts when the viewport index loads after the seed was set', async () => {
    const { store, map } = makeStore({ active: PARCELS[0] });
    let loaded = [];
    map.parcels = () => loaded;
    store.state.buffer.distance = '250';
    store.setTool('buffer');
    expect(store.state.buffer.note).toBe('1 parcel in buffer');   // only the seed so far
    loaded = PARCELS;
    store.indexChanged();
    expect(store.state.buffer.note).toBe('2 parcels in buffer');
  });

  it('CSV: downloads the selection and says when details were withheld', () => {
    const { store, map, download } = makeStore();
    store.downloadCsv();
    expect(download).not.toHaveBeenCalled();  // nothing selected
    map.selected.set('A', { pin: 'A' });
    map.selected.set('B', { pin: 'B', withheld: true });
    store.downloadCsv();
    expect(download).toHaveBeenCalledWith('pin,withheld\nA,\nB,true', 'parcels_2_selected.csv');
    expect(map.notify).toHaveBeenCalledWith(expect.stringMatching(/^1 of 2 parcels were exported without/));
  });
});

describe('the component', () => {
  it('shows the panel for the armed tool and the actions once something is selected', async () => {
    const { store } = makeStore();
    store.indexChanged();
    const w = mount(SelectTools, { props: { store } });
    expect(w.get('#filter-panel').attributes('hidden')).toBeDefined();
    expect(w.get('#sel-actions').attributes('hidden')).toBeDefined();
    await w.get('#tool-filter').trigger('click');
    expect(w.get('#filter-panel').attributes('hidden')).toBeUndefined();
    expect(w.get('#tool-filter').classes()).toContain('active');
    expect(w.findAll('#filter-field option').map((o) => o.text())).toEqual(['— field —', 'pin', 'gis acres', 'owner name']);
    await w.get('#tool-box-select').trigger('click');
    expect(w.get('[data-testid="tool-active-bar"]').text()).toContain('Box Select active');
    store.selectionChanged(2);
    await nextTick();
    expect(w.get('#sel-actions').attributes('hidden')).toBeUndefined();
  });
});
