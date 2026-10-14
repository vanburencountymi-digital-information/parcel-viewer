// The parcel info panel (DIC-2389 slice 3b): when it shows, its title and n-of-N, and its
// controls (×, next/previous, fly to, reopen) and tooltip. The e2e suite checks it in the
// real viewer (search-and-panel, mobile, select-tools, a11y-scan…).
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createParcelCardStore } from '../parcel-card/store.js';
import ParcelPanel from './ParcelPanel.vue';
import { createPanelStore } from './store.js';

function setup() {
  const map = { cycle: vi.fn(), flyTo: vi.fn(), close: vi.fn(), reopen: vi.fn() };
  const panel = createPanelStore({ map });
  const card = createParcelCardStore({ isDark: () => false });
  const w = mount(ParcelPanel, { props: { panel, card }, attachTo: document.body });
  return { map, panel, card, w };
}

describe('the panel store', () => {
  it('opens, collapses to the reopen tab, and hides', () => {
    const panel = createPanelStore({ map: {} });
    expect(panel.isOpen()).toBe(false);
    panel.open();
    expect(panel.isOpen()).toBe(true);
    panel.collapse();
    panel.open();                       // a new parcel doesn't undo a collapse
    expect(panel.isCollapsed()).toBe(true);
    panel.expand();
    expect(panel.isOpen()).toBe(true);
    panel.hide();
    expect([panel.isOpen(), panel.isCollapsed()]).toEqual([false, false]);
  });
});

describe('the component', () => {
  it('shows the panel or the reopen tab, never both', async () => {
    const { panel, w } = setup();
    const region = () => w.get('#parcel-info-panel');
    const tab = () => w.get('#parcel-info-reopen-tab');
    expect([region().attributes('hidden'), tab().attributes('hidden')]).toEqual(['', '']);
    panel.open();
    await nextTick();
    expect(region().attributes('hidden')).toBeUndefined();
    expect(region().attributes('role')).toBe('region');
    panel.collapse();
    await nextTick();
    expect(region().attributes('hidden')).toBe('');
    expect(tab().attributes('hidden')).toBeUndefined();
    w.unmount();
  });

  it('shows n of N for a multi-parcel selection only', async () => {
    const { panel, w } = setup();
    panel.setNav(0, 1);
    await nextTick();
    expect(w.get('#parcel-info-nav').attributes('hidden')).toBe('');
    panel.setNav(1, 3);
    await nextTick();
    expect(w.get('#parcel-info-nav').attributes('hidden')).toBeUndefined();
    expect(w.get('[data-testid="parcel-nav-label"]').text()).toBe('2 of 3');
    w.unmount();
  });

  it('its controls ask map.js: ×, previous, next, fly to, reopen', async () => {
    const { map, w } = setup();
    await w.get('[aria-label="Clear selection"]').trigger('click');
    await w.get('[aria-label="Previous parcel"]').trigger('click');
    await w.get('[aria-label="Next parcel"]').trigger('click');
    await w.get('#parcel-fly-btn').trigger('click');
    await w.get('#parcel-info-reopen-tab').trigger('click');
    expect(map.close).toHaveBeenCalledTimes(1);
    expect(map.cycle.mock.calls).toEqual([[-1], [1]]);
    expect(map.flyTo).toHaveBeenCalledTimes(1);
    expect(map.reopen).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it('the reopen tab moves focus into the panel', async () => {
    const { map, panel, w } = setup();
    map.reopen.mockImplementation(() => panel.expand());   // as map.js's expandInfoPanel does
    panel.collapse();
    await nextTick();
    await w.get('#parcel-info-reopen-tab').trigger('click');
    await nextTick();
    expect(document.activeElement && document.activeElement.id).toBe('parcel-info-panel');
    w.unmount();
  });

  it("titles the region with the panel's title (another layer's feature renames it)", async () => {
    const { panel, w } = setup();
    expect(w.get('#parcel-info-title').text()).toBe('Parcel');
    panel.setTitle('Roads');
    await nextTick();
    expect(w.get('#parcel-info-title').text()).toBe('Roads');
    w.unmount();
  });

  it('shows a label\'s data-tip on hover, on <body>', async () => {
    const { card, w } = setup();
    card.showFeature('<span class="parcel-info-label" data-tip="What this means">Field</span>');
    await nextTick();
    await w.get('[data-tip="What this means"]').trigger('mouseover');
    const tip = document.getElementById('parcel-tip');
    expect(tip.parentElement).toBe(document.body);
    expect(tip.textContent).toBe('What this means');
    expect(tip.classList.contains('parcel-tip-visible')).toBe(true);
    await w.get('[data-tip="What this means"]').trigger('mouseout');
    expect(tip.classList.contains('parcel-tip-visible')).toBe(false);
    w.unmount();
  });
});
