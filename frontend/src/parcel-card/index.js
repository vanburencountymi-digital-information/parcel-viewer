// The parcel info panel's body as a Vue island (DIC-2389 slice 3): mounts into
// .parcel-info-body and publishes window.PV_PARCEL_CARD, which map.js (parcels) and
// pv-feature-info.js (other layers' features) call. The panel around it (header, close,
// next/previous, dragging, focus) is still map.js's.
import { createApp } from 'vue';
import * as viewer from '../shared/viewer.js';
import { parcelPopupSource } from './config.js';
import { createFormatters } from './formatters.js';
import ParcelCard from './ParcelCard.vue';
import { createParcelCardStore } from './store.js';

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

export function mountParcelCard(doc = document) {
  const panel = doc.getElementById('parcel-info-panel');
  const body = panel && panel.querySelector('.parcel-info-body');
  if (!body) return null;
  const store = createParcelCardStore(pageEnv(doc));
  const title = panel.querySelector('.parcel-info-title');
  createApp(ParcelCard, { store }).mount(body);

  globalThis.PV_PARCEL_CARD = {
    show(pin, props, geometry) {
      store.show(pin, props, geometry);
      if (title) title.textContent = 'Parcel';    // another layer's feature may have renamed it
    },
    showFeature(html, featureTitle) {
      store.showFeature(html);
      if (title && featureTitle != null) title.textContent = featureTitle;
    },
  };
  // A parcel may already be on show (shown before this module ran): render it.
  if (globalThis.PS_PARCEL_PANEL) globalThis.PS_PARCEL_PANEL.rerender();
  return store;
}
