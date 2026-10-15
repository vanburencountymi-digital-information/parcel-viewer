// The Help & tools windows moved to Vue components (DIC-2389 slice 5), opened in the
// viewer's modal. Publishes window.PV_WINDOWS.open(name), which admin-menu.js's PV_TOOLS
// calls for these windows; the rest are still admin-menu.js's.
import * as viewer from '../shared/viewer.js';
import AboutWindow from './AboutWindow.vue';
import BookmarksWindow from './BookmarksWindow.vue';
import HelpWindow from './HelpWindow.vue';
import ShareWindow from './ShareWindow.vue';
import WhatsNewWindow from './WhatsNewWindow.vue';

// name → [title, component, props read when the window opens]
const WINDOWS = {
  help: ['Help', HelpWindow, () => ({})],
  'whats-new': ['What\'s New', WhatsNewWindow, () => ({})],
  about: ['About', AboutWindow, () => {
    const acc = viewer.access();
    return { county: viewer.countyConfig(), access: (acc && acc.countyAccess && acc.countyAccess()) || {} };
  }],
  // A link to the selected parcel and the current map view (map.js's PV_VIEW_LINK).
  share: ['Share', ShareWindow, () => ({
    url: globalThis.PV_VIEW_LINK ? globalThis.PV_VIEW_LINK() : globalThis.location.href,
  })],
  bookmark: ['Bookmarks', BookmarksWindow, () => ({
    bookmarks: globalThis.PV_BOOKMARKS,
    parcel: viewer.selectedParcel(),
    openParcel: (id) => { if (globalThis.PS_selectParcelById) globalThis.PS_selectParcelById(id); },
    close: () => globalThis.PV_MODAL.close(),
  })],
};

export function mountWindows() {
  globalThis.PV_WINDOWS = {
    has: (name) => name in WINDOWS,
    open(name) {
      const w = WINDOWS[name];
      const modal = globalThis.PV_MODAL;
      if (!w || !modal) return false;
      const [title, component, props] = w;
      modal.open(title, { component, props: props() });
      return true;
    },
  };
  return globalThis.PV_WINDOWS;
}
