// The Map Control Panel as a Vue island (DIC-2389 slice 4a): its header, tab strip and
// Advanced toggle. Mounts inside #map-control-panel, keeping the page's pane elements (the
// Layers, Drawing and Measurement panes are wired by classic scripts before this runs, and
// Selection Tools is its own island). Publishes window.PV_MAP_CONTROLS, which map.js's
// PS_MAP_PANEL (Map Buddy, hints) calls to switch tabs.
import { createApp } from 'vue';
import * as viewer from '../shared/viewer.js';
import MapControls from './MapControls.vue';
import { createControlsStore, TABS } from './store.js';

const ADVANCED_KEY = 'pv-advanced-tools';

export function mountMapControls(doc = document) {
  const host = doc.getElementById('map-control-panel');
  if (!host) return null;
  // Take the panes out before mounting (mounting replaces the panel's children), then
  // MapControls puts them back into its body: same elements, listeners intact.
  const panes = {};
  for (const t of TABS) {
    const pane = doc.getElementById(`mcp-pane-${t.id}`);
    if (pane) { pane.remove(); panes[t.id] = pane; }
  }

  const g = globalThis;
  const tools = (viewer.countyConfig().tools) || {};
  const store = createControlsStore({
    capEnabled: viewer.capEnabled,
    advancedTabs: Array.isArray(tools.advanced) ? tools.advanced : null,
    storage: {
      get: () => { try { return localStorage.getItem(ADVANCED_KEY) === '1'; } catch { return false; } },
      set: (on) => { try { localStorage.setItem(ADVANCED_KEY, on ? '1' : '0'); } catch { /* private mode */ } },
    },
    // The drawing and measure tools arm when their tab opens and disarm when it closes.
    onTabChange(prev, next) {
      const draw = g.PS_DRAWING_TOOLS;
      if (draw) { if (next === 'draw') draw.onDrawTabActivated(); else if (prev === 'draw') draw.onDrawTabDeactivated(); }
      const measure = g.PS_MEASURE_TOOL;
      if (measure) { if (next === 'measure') measure.onMeasureTabActivated(); else if (prev === 'measure') measure.onMeasureTabDeactivated(); }
    },
  });
  createApp(MapControls, { store, host, panes }).mount(host);

  // The reopen tab (outside the panel) shows it again, at its default position: a drag
  // made while the map was wider could otherwise leave it outside the map area.
  const reopen = doc.getElementById('mcp-reopen-tab');
  if (reopen) {
    reopen.addEventListener('click', () => {
      host.style.left = host.style.top = host.style.right = host.style.bottom = '';
      host.hidden = false;
      reopen.hidden = true;
    });
  }

  g.PV_MAP_CONTROLS = { setTab: store.setTab, getTab: store.getTab, setAdvanced: store.setAdvanced };
  return store;
}
