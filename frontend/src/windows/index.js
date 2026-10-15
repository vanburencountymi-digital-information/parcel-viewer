// The Help & tools windows moved to Vue components (DIC-2389 slice 5), opened in the
// viewer's modal. Publishes window.PV_WINDOWS.open(name), which admin-menu.js's PV_TOOLS
// calls for these windows; the rest are still admin-menu.js's.
import * as viewer from '../shared/viewer.js';
import AboutWindow from './AboutWindow.vue';
import BookmarksWindow from './BookmarksWindow.vue';
import DataRequestWindow from './DataRequestWindow.vue';
import HelpWindow from './HelpWindow.vue';
import ReportErrorWindow from './ReportErrorWindow.vue';
import SettingsWindow from './SettingsWindow.vue';
import ShareWindow from './ShareWindow.vue';
import WhatsNewWindow from './WhatsNewWindow.vue';

const DATA_REQUEST_FORM_URL = 'https://form.jotform.com/261544522974159';

/** The county's data request form (COUNTY.forms.dataRequest), http(s) only, else ours. */
export function dataRequestUrl(county) {
  const u = county && county.forms && county.forms.dataRequest;
  return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : DATA_REQUEST_FORM_URL;
}

/** POSTs a data-error report; rejects on an HTTP error (with .status) or an { ok: false } answer. */
export async function sendReport(data, fetchFn = globalThis.fetch) {
  const r = await fetchFn(`${viewer.apiBase()}/report-error`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  const res = await r.json();
  if (res && res.ok === false) throw new Error(res.error || 'Server error');
  return res;
}

const close = () => globalThis.PV_MODAL.close();

// name → [title, component, props read when the window opens, modal options]
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
    close,
  })],
  // The preference hooks: PV_PREFS, map.js's PV_COORDS, hints.js's PS_HINTS, and
  // admin-menu.js's PV_SCHEME, PV_GLASS and PV_A11Y.
  settings: ['Settings', SettingsWindow, () => ({
    prefs: viewer.prefs(),
    coords: globalThis.PV_COORDS || null,
    hints: globalThis.PS_HINTS || null,
    scheme: globalThis.PV_SCHEME || null,
    glass: globalThis.PV_GLASS || null,
    a11y: globalThis.PV_A11Y || null,
  })],
  'report-error': ['Report a data error', ReportErrorWindow, () => {
    const p = viewer.selectedParcel();
    return { pin: (p && p.pin) || '', send: (data) => sendReport(data), close };
  }],
  'data-request': ['Data Request', DataRequestWindow,
    () => ({ url: dataRequestUrl(viewer.countyConfig()) }), { wide: true, flush: true }],
};

export function mountWindows() {
  globalThis.PV_WINDOWS = {
    has: (name) => name in WINDOWS,
    open(name) {
      const w = WINDOWS[name];
      const modal = globalThis.PV_MODAL;
      if (!w || !modal) return false;
      const [title, component, props, opts] = w;
      modal.open(title, { component, props: props() }, null, opts);
      return true;
    },
  };
  return globalThis.PV_WINDOWS;
}
