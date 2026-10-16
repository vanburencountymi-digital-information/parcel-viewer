// The Help & tools menu and the viewer's modal as Vue islands (DIC-2389 slice 5):
//   - the menu mounts inside #pv-admin; its items open windows through PV_TOOLS;
//   - the modal mounts on <body> and publishes window.PV_MODAL { open, close, isOpen },
//     which the Vue windows (frontend/src/windows/, through PV_WINDOWS) and admin-menu.js's
//     openModal/closeModal use.
import { createApp } from 'vue';
import ModalHost from '../modal/ModalHost.vue';
import { createModalStore } from '../modal/store.js';
import * as viewer from '../shared/viewer.js';
import HelpMenu from './HelpMenu.vue';
import { visibleItems } from './items.js';

export function mountModal(doc = document) {
  const store = createModalStore();
  const host = doc.createElement('div');
  host.id = 'pv-modal-root';
  doc.body.appendChild(host);
  createApp(ModalHost, { store }).mount(host);
  globalThis.PV_MODAL = { open: store.open, close: store.close, isOpen: store.isOpen };
  return store;
}

export function mountHelpMenu(doc = document) {
  const host = doc.getElementById('pv-admin');
  if (!host) return null;
  const openTool = (tool) => { const t = globalThis.PV_TOOLS; if (t) t.open(tool); };
  return createApp(HelpMenu, { items: visibleItems(viewer.capEnabled), openTool }).mount(host);
}
