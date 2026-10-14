// Compare (DIC-589) as a Vue island (DIC-2389): mounts the tray and table at the end of
// <body> and publishes window.PV_COMPARE, the API the parcel panel's menu (admin-menu.js),
// Map Buddy and the tests call. Capability-gated 'compare' (default-on).
import { createApp } from 'vue';
import { toast } from '../shared/toast.js';
import * as viewer from '../shared/viewer.js';
import CompareRoot from './CompareRoot.vue';
import { createCompareStore } from './store.js';

export function mountCompare(doc = document) {
  const store = createCompareStore({ viewer, toast: (msg) => toast(msg, doc) });
  const host = doc.createElement('div');
  host.id = 'pv-compare-root';
  doc.body.appendChild(host);
  createApp(CompareRoot, { store, dialog: viewer.dialog() }).mount(host);

  globalThis.PV_COMPARE = {
    add: store.add,
    addCurrent: store.addCurrent,
    remove: store.remove,
    clear: store.clear,
    open: store.open,
    show: store.show,
    has: store.has,
    isEnabled: store.isEnabled,
  };
  return store;
}
