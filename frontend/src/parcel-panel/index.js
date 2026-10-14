// The parcel info panel as a Vue island (DIC-2389 slice 3): the reopen tab, the panel
// (title, ×, next/previous, dragging) and its card. Mounted in place of
// #parcel-panel-root. It publishes:
//   - window.PV_PARCEL_PANEL: when it shows, for map.js (selection, mobile tabs) and
//     pv-feature-info.js;
//   - window.PV_PARCEL_CARD: what the card shows (a parcel, or another layer's feature).
// The panel's controls call map.js's side of it, window.PS_PARCEL_PANEL.
import { createApp, nextTick } from 'vue';
import { parcelPopupSource } from '../parcel-card/config.js';
import { createFormatters } from '../parcel-card/formatters.js';
import { createParcelCardStore } from '../parcel-card/store.js';
import * as viewer from '../shared/viewer.js';
import ParcelPanel from './ParcelPanel.vue';
import { createPanelStore } from './store.js';

function storedPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

// What the card needs from the page, read when a parcel is shown (preferences and the
// manifest can change between parcels).
function pageEnv(doc) {
  const g = globalThis;
  return {
    isDark: () => doc.documentElement.getAttribute('data-theme') === 'dark',
    selectedParcel: viewer.selectedParcel,
    toggleBookmark: (pc) => (g.PV_BOOKMARKS ? g.PV_BOOKMARKS.toggle(pc) : false),
    cardDeps() {
      const labels = viewer.countyConfig().labels || {};
      const coords = g.PV_COORD_FMT;
      const turf = viewer.turf();
      const manifestSource = g.PV_MANIFEST && g.PV_MANIFEST.source && g.PV_MANIFEST.source('parcels');
      const assessing = viewer.countyConfig().assessing || {};
      const explainer = g.ISV_EXPLAINER_CORE;
      const acc = viewer.access();
      return {
        popup: g.ISV_POPUP,
        source: parcelPopupSource(manifestSource),
        labels,
        formatters: createFormatters({
          labels,
          areaUnits: () => storedPref('pv-area-units', 'acres'),
          // A point inside the parcel (not its bbox centre, which can fall outside a
          // concave parcel), in the coordinate readout's format.
          formatPoint: (geometry) => {
            if (!geometry || !coords || !turf || !turf.pointOnFeature) return null;
            try {
              const [lng, lat] = turf.pointOnFeature({ type: 'Feature', geometry }).geometry.coordinates;
              const fmt = storedPref('pv-coord-format', 'dd');
              return coords.readout({ lng, lat }, coords.readoutFormats.includes(fmt) ? fmt : 'dd');
            } catch { return null; }
          },
        }),
        // The tax-roll year the AV history ends at (DIC-1878): the engine's rule.
        rollYear: (p) => (explainer && explainer.resolveRollYear
          ? explainer.resolveRollYear(p, { rollYear: assessing.rollYear }).year
          : parseInt(assessing.rollYear, 10) || parseInt(p && p.roll_year, 10) || new Date().getFullYear()),
        isWithheld: (p) => !!(acc && acc.isWithheld(p)),
        isBookmarked: (id) => !!(g.PV_BOOKMARKS && g.PV_BOOKMARKS.has(id)),
      };
    },
  };
}

export function mountParcelPanel(doc = document) {
  const root = doc.getElementById('parcel-panel-root');
  const map = globalThis.PS_PARCEL_PANEL;
  if (!root || !map) return null;      // not the viewer page, or map.js didn't load
  const panel = createPanelStore({ map });
  const card = createParcelCardStore(pageEnv(doc));
  const vm = createApp(ParcelPanel, { panel, card }).mount(root);

  globalThis.PV_PARCEL_PANEL = {
    isOpen: panel.isOpen,
    isCollapsed: panel.isCollapsed,
    open: panel.open,
    collapse: panel.collapse,
    expand: panel.expand,
    hide: panel.hide,
    setNav: panel.setNav,
    /** Moves focus into the panel once it shows (the keyboard search path, DIC-385). */
    focus: () => nextTick(() => { if (vm.panelEl) vm.panelEl.focus(); }),
  };
  globalThis.PV_PARCEL_CARD = {
    show(pin, props, geometry) {
      card.show(pin, props, geometry);
      panel.setTitle('Parcel');         // another layer's feature may have renamed it
    },
    showFeature(html, featureTitle) {
      card.showFeature(html);
      if (featureTitle != null) panel.setTitle(featureTitle);
      panel.expand();
    },
  };

  // The arrow keys move through a multi-parcel selection, unless a field or a dialog
  // has the keyboard.
  doc.addEventListener('keydown', (e) => {
    if (!panel.isOpen() || panel.state.count < 2 || map.dialogOpen()) return;
    const tag = doc.activeElement && doc.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); panel.cycle(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); panel.cycle(1); }
  });

  // A parcel may have been selected before this module ran: show it.
  map.restore();
  return { panel, card };
}
