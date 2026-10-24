// Mounting Map Buddy (DIC-2389): map-buddy.js's MapBuddy.mount / unmount, remembered until
// the Vue island attaches, and what the mount does to the host page. Commands and fetch
// are faked; no request reaches a model.
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountMapBuddyIsland } from './index.js';

beforeAll(async () => {
  await import('../../../map-buddy/js/map-buddy.js');   // a classic script: window.MapBuddy
  // The panel adds its stylesheet's <link>; don't let happy-dom go and fetch it.
  window.happyDOM.settings.disableCSSFileLoading = true;
});

let prevSelect;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"><div id="panel-map" style="min-width: 300px"></div></div><button id="mcp-reopen-tab"></button>';
  localStorage.clear();
  window.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ workflows: [] }) }));
  window.PV_MAP_BUDDY_COMMANDS = { create: () => ({ run: (c) => c.map((x) => x.type), buildMapState: () => null, cancelCinematic() {}, selectResult() {} }) };
  prevSelect = vi.fn();
  window.PS_onParcelSelect = prevSelect;
});
afterEach(() => window.MapBuddy.unmount());

describe('MapBuddy.mount with the island', () => {
  it('a mount asked for before the island loads happens when it attaches; the page is set up', async () => {
    window.MapBuddy.mount({ apiBase: '/mb' });
    expect(window.MapBuddy.pending).toEqual({ apiBase: '/mb' });
    expect(document.getElementById('map-buddy-panel')).toBeNull();

    mountMapBuddyIsland(window);
    await flushPromises();
    const host = document.getElementById('map-buddy-panel');
    expect(host.parentElement.id).toBe('app');
    expect(host.className).toBe('mb-panel mb-collapsed');
    expect(host.querySelector('#mb-input')).not.toBeNull();
    expect(document.querySelector('link[href="/map-buddy/css/map-buddy.css"]')).not.toBeNull();
    expect(document.getElementById('panel-map').style.minWidth).toMatch(/^0(px)?$/);
    expect(window.fetch).toHaveBeenCalledWith('/mb/workflows');
    expect(Object.keys(window.PV_MAP_BUDDY).sort()).toEqual(['ask', 'buildMapState', 'collapse', 'isOpen', 'lookAtMap', 'open', 'runCommands', 'send', 'toggle']);
    expect(window.MapBuddy.pending).toBeNull();
  });

  it('opening widens the panel and moves the map-controls tab; a parcel selection still reaches the old handler', async () => {
    window.MapBuddy.mount({ apiBase: '/mb' });
    mountMapBuddyIsland(window);
    const host = document.getElementById('map-buddy-panel');
    window.PV_MAP_BUDDY.open();
    await flushPromises();
    expect(window.PV_MAP_BUDDY.isOpen()).toBe(true);
    expect(host.classList.contains('mb-collapsed')).toBe(false);
    expect(host.style.width).toBe('340px');
    expect(document.getElementById('mcp-reopen-tab').style.right).toBe('340px');
    expect(localStorage.getItem('mb:collapsed')).toBe('false');
    window.PV_MAP_BUDDY.toggle();
    await flushPromises();
    expect(document.getElementById('mcp-reopen-tab').style.right).toBe('28px');

    window.PS_onParcelSelect({ pin: '80-01', acres: 1 });
    await flushPromises();
    expect(prevSelect).toHaveBeenCalledWith({ pin: '80-01', acres: 1 });
    expect(host.querySelector('#mb-context-text').textContent).toBe('80-01 · 1.0 ac');
    expect(window.PV_MAP_BUDDY.runCommands([{ type: 'zoom_to' }])).toEqual(['zoom_to']);
  });

  it('unmount puts the page back; a mount after the island loaded happens at once', async () => {
    mountMapBuddyIsland(window);
    expect(document.getElementById('map-buddy-panel')).toBeNull();   // nobody asked yet
    window.MapBuddy.mount({});
    expect(document.getElementById('map-buddy-panel')).not.toBeNull();
    window.MapBuddy.unmount();
    expect(document.getElementById('map-buddy-panel')).toBeNull();
    expect(window.PV_MAP_BUDDY).toBeUndefined();
    expect(window.PS_onParcelSelect).toBe(prevSelect);
    expect(document.getElementById('panel-map').style.minWidth).toBe('300px');
    expect(document.querySelector('link[href="/map-buddy/css/map-buddy.css"]')).toBeNull();
  });

  it('without the map commands on the page, the island does nothing', () => {
    delete window.PV_MAP_BUDDY_COMMANDS;
    expect(mountMapBuddyIsland(window)).toBeNull();
  });
});
