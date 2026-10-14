// Parcel search as a Vue island (DIC-2389 slice 5): mounts inside #parcel-search and wires
// the mobile overlay (#pv-search-btn opens it). Picking a result asks map.js
// (PS_SEARCH_MAP.select) to select the parcel and move focus into the parcel panel.
// Publishes window.PV_SEARCH (isOpen), which map.js's Esc handling checks: search owns Esc
// first.
import { createApp } from 'vue';
import * as viewer from '../shared/viewer.js';
import SearchBox from './SearchBox.vue';
import { createSearchStore } from './store.js';

export function mountSearch(doc = document) {
  const host = doc.getElementById('parcel-search');
  const map = globalThis.PS_SEARCH_MAP;
  if (!host || !map) return null;

  let vm = null;
  // The mobile overlay: closing keeps the query and results, so reopening shows them again
  // (as on desktop, where you can come back to the other matches without re-searching).
  function closeOverlay() {
    host.classList.remove('pv-search-open');
    store.hide();
  }
  const store = createSearchStore({
    fetch: (...a) => globalThis.fetch(...a),
    apiBase: viewer.apiBase,
    noteAccess: (d) => { const acc = viewer.access(); return acc ? acc.note(d) : d; },
    select(id) {
      map.select(id, vm && vm.input);
      closeOverlay();
    },
  });
  vm = createApp(SearchBox, { store, onClose: closeOverlay }).mount(host);

  // The search icon button (mobile) opens the overlay, showing any results still there.
  // stopPropagation, so the click-outside handler below doesn't hide them again at once.
  const btn = doc.getElementById('pv-search-btn');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      host.classList.add('pv-search-open');
      store.reveal();
      setTimeout(() => vm.input && vm.input.focus(), 60);
    });
  }
  // A tap on the overlay's backdrop (the container itself) closes it.
  host.addEventListener('click', (e) => { if (e.target === host) closeOverlay(); });
  // A click anywhere else closes the results list.
  doc.addEventListener('click', (e) => { if (!e.target.closest('#parcel-search')) store.hide(); });

  globalThis.PV_SEARCH = { isOpen: store.isOpen };
  return store;
}
