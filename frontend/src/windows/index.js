// The Help & tools windows moved to Vue components (DIC-2389 slice 5), opened in the
// viewer's modal. Publishes window.PV_WINDOWS.open(name), which admin-menu.js's PV_TOOLS
// calls for these windows; the rest are still admin-menu.js's.
import * as viewer from '../shared/viewer.js';
import AboutWindow from './AboutWindow.vue';
import BookmarksWindow from './BookmarksWindow.vue';
import DataRequestWindow from './DataRequestWindow.vue';
import HelpWindow from './HelpWindow.vue';
import PrintWindow from './PrintWindow.vue';
import ReportErrorWindow from './ReportErrorWindow.vue';
import SettingsWindow from './SettingsWindow.vue';
import ShareWindow from './ShareWindow.vue';
import StreetViewWindow from './StreetViewWindow.vue';
import WhatsNewWindow from './WhatsNewWindow.vue';
import { centroidOf, mapsUrl, resolveTarget } from './streetview.js';
import PacketWindow from './packet/PacketWindow.vue';

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

/**
 * Street View for the selected parcel. With the county's embed key it opens in the modal;
 * without one, Google Maps opens in a new tab. That tab opens now, inside the click, so it
 * isn't popup-blocked, and goes to the viewpoint once it's found.
 */
export function openStreetView(modal, { win = globalThis } = {}) {
  const parcel = viewer.selectedParcel();
  if (!centroidOf(parcel)) {
    modal.open('Street View', { component: StreetViewWindow, props: { parcel: null } });
    return;
  }
  const integrations = viewer.countyConfig().integrations || {};
  const key = integrations.googleMapsEmbedKey || '';
  const resolve = () => resolveTarget(parcel, { base: viewer.apiBase() });
  if (key) {
    modal.open('Street View', {
      component: StreetViewWindow,
      props: { parcel, apiKey: key, resolve, turf: viewer.turf() },
    }, null, { wide: true, flush: true });
    return;
  }
  const tab = win.open('about:blank', '_blank');
  try { if (tab) tab.opener = null; } catch { /* cross-origin already */ }
  resolve().then(({ vp, lookAt }) => {
    const url = mapsUrl(vp, lookAt, viewer.turf());
    if (tab) tab.location.href = url; else win.open(url, '_blank', 'noopener');
  });
}

/** The Parcel Packet for the selected parcel (wide and flush), or the note to pick one. */
export function openPacket(modal) {
  const parcel = viewer.selectedParcel();
  if (!parcel) {
    modal.open('Parcel Packet', { component: PacketWindow, props: { parcel: null } });
    return;
  }
  const acc = viewer.access();
  const withheld = !parcel.owner_name && !!(acc && acc.getState && acc.getState().withheld);
  modal.open('Parcel Packet', { component: PacketWindow, props: { parcel, withheld } }, null, { wide: true, flush: true });
}

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
  // The parcel summary is pv-doc.js's PV_DOC.
  print: ['Print', PrintWindow, () => ({
    parcel: viewer.selectedParcel(),
    doc: globalThis.PV_DOC || null,
    print: () => globalThis.print(),
    close,
  })],
};

// Windows that open some other way than "this component, now".
const OPENERS = { streetview: openStreetView, packet: openPacket };

export function mountWindows() {
  globalThis.PV_WINDOWS = {
    has: (name) => name in WINDOWS || name in OPENERS,
    open(name) {
      const w = WINDOWS[name];
      const modal = globalThis.PV_MODAL;
      if (!modal) return false;
      if (OPENERS[name]) { OPENERS[name](modal); return true; }
      if (!w) return false;
      const [title, component, props, opts] = w;
      modal.open(title, { component, props: props() }, null, opts);
      return true;
    },
  };
  return globalThis.PV_WINDOWS;
}
