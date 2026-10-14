// Parcel search (DIC-2389 slice 5): debounce and abort, results and errors, the combobox
// keys, Esc, and tax-roll values rendered as text (DIC-1852). The e2e suite checks it in the
// real viewer (search-and-panel, mobile, a11y-scan…).
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import SearchBox from './SearchBox.vue';
import { createSearchStore } from './store.js';

const EVIL = '<img src=x onerror=alert(1)>';
const RESULTS = [
  { id: 1, pin: '80-01-001-001-00', municipality: 'Paw Paw', owner_name: 'SMITH', address: '1 MAIN ST' },
  { id: 2, pin: '80-01-001-002-00', municipality: null, owner_name: null, address: null },
];

// Timers run at once; fetch answers with `body` (or the given status).
function setup({ body = { results: RESULTS }, status = 200 } = {}) {
  const select = vi.fn();
  const fetch = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
  const timers = { setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {} };
  const store = createSearchStore({ fetch, apiBase: () => '/api', select, timers });
  return { store, fetch, select };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the store', () => {
  it('searches from two characters, and says how many it found', async () => {
    const { store, fetch } = setup();
    store.input('p');
    expect(fetch).not.toHaveBeenCalled();
    store.input('paw paw');
    await settle();
    expect(fetch.mock.calls[0][0]).toBe('/api/search?q=paw%20paw&limit=25');
    expect(store.state.results).toHaveLength(2);
    expect(store.state.status).toBe('2 results found, use up and down arrow keys to navigate');
  });

  it('clears below two characters', async () => {
    const { store } = setup();
    store.input('paw');
    await settle();
    store.input('p');
    expect([store.state.results.length, store.state.open, store.state.status]).toEqual([0, false, '']);
  });

  it('says so when nothing matches, or when search fails', async () => {
    const none = setup({ body: { results: [] } });
    none.store.input('zzz');
    await settle();
    expect([none.store.state.message, none.store.state.error]).toEqual(['No matches found', false]);
    const busy = setup({ status: 429 });
    busy.store.input('paw');
    await settle();
    expect(busy.store.state.error).toBe(true);
    expect(busy.store.state.message).toMatch(/^Too many searches/);
  });

  it('moves through the results with the arrow keys, Home and End, and picks with Enter', async () => {
    const { store, select } = setup();
    store.input('paw');
    await settle();
    expect(store.key('ArrowDown')).toBe(true);
    store.key('ArrowDown');
    store.key('ArrowDown');                    // wraps around
    expect(store.state.active).toBe(0);
    store.key('End');
    expect(store.state.active).toBe(1);
    expect(store.key('Enter')).toBe(true);
    expect(select).toHaveBeenCalledWith(2);
    expect(store.state.open).toBe(false);
  });

  it('Esc closes the list first, then clears the search', async () => {
    const { store } = setup();
    store.input('paw');
    await settle();
    expect(store.escape()).toBe('hid');
    expect(store.state.results).toHaveLength(2);   // kept: focusing again shows them
    store.reveal();
    expect(store.state.open).toBe(true);
    store.escape();
    expect(store.escape()).toBe('cleared');
    expect([store.state.query, store.state.results.length]).toEqual(['', 0]);
  });
});

describe('the component', () => {
  it('renders hostile tax-roll values as text, never markup (DIC-1852)', async () => {
    const { store } = setup({ body: { results: [{ id: 9, pin: EVIL, municipality: EVIL, owner_name: 'A & B ' + EVIL, address: EVIL }] } });
    const w = mount(SearchBox, { props: { store } });
    store.input('smith');
    await settle();
    await nextTick();
    expect(w.find('img').exists()).toBe(false);
    const row = w.get('[role="option"]');
    expect(row.text()).toContain('A & B ' + EVIL);
    expect(row.text().split(EVIL).length - 1).toBe(4);   // pin, municipality, owner, address
  });

  it('is an ARIA combobox: expanded, active descendant, selected option', async () => {
    const { store } = setup();
    const w = mount(SearchBox, { props: { store } });
    const input = w.get('#parcel-search-input');
    expect(input.attributes('aria-expanded')).toBe('false');
    store.input('paw');
    await settle();
    await nextTick();
    expect(input.attributes('aria-expanded')).toBe('true');
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(input.attributes('aria-activedescendant')).toBe('psr-opt-0');
    expect(w.get('#psr-opt-0').attributes('aria-selected')).toBe('true');
    expect(w.get('#psr-opt-1').text()).toContain('—');   // no owner on record
  });

  it('Esc on an empty list asks to close the mobile overlay', async () => {
    const { store } = setup();
    const w = mount(SearchBox, { props: { store } });
    await w.get('#parcel-search-input').trigger('keydown', { key: 'Escape' });
    expect(w.emitted('close')).toHaveLength(1);
  });
});
