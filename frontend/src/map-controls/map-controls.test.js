// The Map Control Panel (DIC-2389 slice 4a): tabs, the Advanced toggle, capability gating,
// the tool hooks, and the page's panes kept as they are. The e2e suite checks it in the real
// viewer (map-controls, select-tools, measure-and-draw, mobile, a11y-scan…).
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import MapControls from './MapControls.vue';
import { createControlsStore } from './store.js';

function memoryStorage(initial = false) {
  let on = initial;
  return { get: () => on, set: (v) => { on = v; } };
}

describe('the store', () => {
  it('starts on Layers with the advanced tabs as last chosen', () => {
    const s = createControlsStore({ storage: memoryStorage(true) });
    expect(s.getTab()).toBe('layers');
    expect(s.state.advanced).toBe(true);
    expect(s.title.value).toBe('Layers');
  });

  it('runs the tool hooks on every switch', () => {
    const onTabChange = vi.fn();
    const s = createControlsStore({ storage: memoryStorage(), onTabChange });
    s.setTab('draw');
    s.setTab('measure');
    expect(onTabChange.mock.calls).toEqual([['layers', 'draw'], ['draw', 'measure']]);
    expect(s.title.value).toBe('Measure');
  });

  it('hiding the advanced tabs while one is active goes back to Layers', () => {
    const storage = memoryStorage(true);
    const s = createControlsStore({ storage });
    s.setTab('select');
    s.setAdvanced(false);
    expect(s.getTab()).toBe('layers');
    expect(storage.get()).toBe(false);
  });

  it("follows the county's advanced list", () => {
    const s = createControlsStore({ storage: memoryStorage(), advancedTabs: ['measure'] });
    expect(s.tabs.filter((t) => t.advanced).map((t) => t.id)).toEqual(['measure']);
  });

  it('never starts on a tab that is not shown', () => {
    // Layers gated off: with the advanced tabs showing, Selection is the first tab shown.
    const adv = createControlsStore({ storage: memoryStorage(true), capEnabled: (cap) => cap !== 'layers' });
    expect(adv.getTab()).toBe('select');
    // Without them, no tab is shown; it stays put rather than landing on another hidden one.
    const s = createControlsStore({ storage: memoryStorage(false), capEnabled: (cap) => cap !== 'layers' });
    expect(s.tabs.some((t) => !t.gated && !t.advanced)).toBe(false);
  });

  it('hiding the advanced tabs falls back to a tab that is shown, not a gated one', () => {
    const s = createControlsStore({ storage: memoryStorage(true), capEnabled: (cap) => cap !== 'measure', advancedTabs: ['select', 'measure'] });
    s.setTab('select');
    s.setAdvanced(false);
    expect(['layers', 'draw']).toContain(s.getTab());
  });
});

function setup(opts = {}) {
  const host = document.createElement('div');
  host.id = 'map-control-panel';
  document.body.appendChild(host);
  const panes = {};
  for (const id of ['layers', 'select', 'draw', 'measure']) {
    const pane = document.createElement('div');
    pane.id = `mcp-pane-${id}`;
    pane.textContent = id;
    pane.onclick = vi.fn();                 // a listener a classic script attached
    panes[id] = pane;
  }
  const store = createControlsStore({ storage: memoryStorage(), ...opts });
  const w = mount(MapControls, { props: { store, host, panes }, attachTo: host });
  return { host, panes, store, w };
}

describe('the component', () => {
  it('moves the page panes into its body as they are, one showing at a time', async () => {
    const { panes, w } = setup();
    await nextTick();
    expect(w.get('.mcp-body').element.children.length).toBe(4);
    expect(panes.layers.hidden).toBe(false);
    expect(panes.draw.hidden).toBe(true);
    panes.layers.click();
    expect(panes.layers.onclick).toHaveBeenCalled();   // its listener survived the move
    w.unmount();
  });

  it('switches tabs, titles the header and marks the active tab', async () => {
    const { panes, store, w } = setup();
    store.setAdvanced(true);
    await w.get('[data-tab="measure"]').trigger('click');
    await nextTick();
    expect(panes.measure.hidden).toBe(false);
    expect(panes.layers.hidden).toBe(true);
    expect(w.get('#mcp-header-title').text()).toBe('Measure');
    expect(w.get('[data-tab="measure"]').attributes('aria-selected')).toBe('true');
    expect(w.get('[data-tab="layers"]').attributes('aria-selected')).toBe('false');
    w.unmount();
  });

  it('the Advanced toggle sets the panel class and its own pressed state', async () => {
    const { host, w } = setup();
    expect(host.classList.contains('mcp-show-advanced')).toBe(false);
    await w.get('#mcp-advanced-toggle').trigger('click');
    expect(host.classList.contains('mcp-show-advanced')).toBe(true);
    expect(w.get('#mcp-advanced-toggle').attributes('aria-pressed')).toBe('true');
    expect(w.get('[data-tab="select"]').attributes('data-advanced')).toBe('true');
    expect(w.get('[data-tab="layers"]').attributes('data-advanced')).toBeUndefined();
    w.unmount();
  });

  it('hides a gated tab and its pane', async () => {
    const { panes, w } = setup({ capEnabled: (cap) => cap !== 'drawing' });
    await nextTick();
    expect(w.get('[data-tab="draw"]').attributes('style')).toContain('display: none');
    expect(panes.draw.hidden).toBe(true);
    w.unmount();
  });

  it('× hides the panel and shows the reopen tab', async () => {
    const reopen = document.createElement('button');
    reopen.id = 'mcp-reopen-tab';
    reopen.hidden = true;
    document.body.appendChild(reopen);
    const { host, w } = setup();
    await w.get('#mcp-header-close').trigger('click');
    expect(host.hidden).toBe(true);
    expect(reopen.hidden).toBe(false);
    w.unmount();
    reopen.remove();
  });
});
