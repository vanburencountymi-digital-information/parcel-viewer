// Map Buddy's panel as a Vue island (DIC-2389). The host page keeps the two-line contract:
// map-buddy-commands.js, map-buddy.js (which defines MapBuddy.mount / unmount), and a
// MapBuddy.mount({ apiBase }) call (pv-map-buddy-mount.js). map-buddy.js remembers that
// call; this island does the mount once the page's classic scripts have run.
//
// The panel is #map-buddy-panel, appended to #app: the island keeps its classes and
// width, and the host page in step (the map shrinks when it opens; the map-controls tab
// moves clear of it; on a phone, the map takes the top half). The map commands stay plain
// JS (map-buddy-commands.js), created by the store with it as their adapter.
//
// Publishes window.PV_MAP_BUDDY: open, collapse, toggle, isOpen, ask, lookAtMap (the panel,
// for hints.js, the mobile tab bar and the right-click menu) and send, runCommands,
// buildMapState (the command path; the e2e suite drives the map through runCommands).
import { createApp, ref, watch, watchEffect } from 'vue';
import MapBuddyPanel from './MapBuddyPanel.vue';
import { createMapBuddyStore } from './store.js';

const MOBILE_MAX = 640;
const COLLAPSED_TAB_RIGHT = 28;   // the map-controls tab's offset beside the collapsed tab

export function mountMapBuddy(opts = {}, win = globalThis) {
  const doc = win.document;
  const viewportWidth = ref(win.innerWidth);
  const isMobile = () => viewportWidth.value <= MOBILE_MAX;
  const apiBase = opts.apiBase || win.API_BASE || '/api';

  // The stylesheet, beside the script as before.
  const css = doc.createElement('link');
  css.rel = 'stylesheet';
  css.href = opts.cssUrl || '/map-buddy/css/map-buddy.css';
  doc.head.appendChild(css);

  const host = doc.createElement('div');
  host.id = 'map-buddy-panel';
  host.className = 'mb-panel mb-collapsed';
  (opts.container || doc.getElementById('app') || doc.body).appendChild(host);

  // Let #panel-map shrink when the panel opens.
  const panelMap = doc.getElementById('panel-map');
  const origMinWidth = panelMap ? panelMap.style.minWidth : null;
  if (panelMap) panelMap.style.minWidth = '0';

  const store = createMapBuddyStore({
    fetch: (...a) => win.fetch(...a),
    apiBase: () => apiBase,
    storage: () => win.localStorage,
    commands: (ui) => win.PV_MAP_BUDDY_COMMANDS.create(ui),
    vision: () => win.PV_VISION || null,
    map: () => win.PS_MAP || null,
    citationsEnabled: () => !(win.PV_CITATIONS && win.PV_CITATIONS.isEnabled && !win.PV_CITATIONS.isEnabled()),
    isMobile,
  });
  const state = store.state;

  // ── The host page, in step with the panel ─────────────────────────────────
  const mcpTab = () => doc.getElementById('mcp-reopen-tab');
  const stop = [];
  stop.push(watchEffect(() => {
    host.classList.toggle('mb-collapsed', !state.open);
    host.classList.toggle('mb-resizing', state.resizing);
    if (!isMobile()) {
      host.style.width = state.open ? state.width + 'px' : '';
      const tab = mcpTab();
      if (tab) tab.style.right = (state.open ? state.width : COLLAPSED_TAB_RIGHT) + 'px';
    }
    // Mobile split-screen: only mobile + open pushes the map into the top half.
    doc.body.classList.toggle('mb-mobile-open', state.open && isMobile());
  }));
  // Opening or closing resizes the map; the map handle (PS_MAP) is only published after
  // the map's 'load', which may lag a first open, so it's refit a few times.
  stop.push(watch(() => state.open, () => {
    const fit = () => {
      const map = win.PS_MAP;
      if (map && typeof map.resize === 'function') map.resize();
      else win.dispatchEvent(new Event('resize'));   // MapLibre's trackResize
    };
    fit();
    win.setTimeout(fit, 80);
    win.setTimeout(fit, 260);
    if (win.PV_MOBILE_TABS && win.PV_MOBILE_TABS.refresh) win.PV_MOBILE_TABS.refresh();
  }));
  const onResize = () => { viewportWidth.value = win.innerWidth; };
  win.addEventListener('resize', onResize);

  // The parcel Map Buddy talks about: chained onto any existing handler.
  const prevOnSelect = win.PS_onParcelSelect || null;
  win.PS_onParcelSelect = (parcel) => {
    if (prevOnSelect) prevOnSelect(parcel);
    store.setParcel(parcel);
  };
  const onSelectionChanged = () => { if (!win.PS_STATE || !win.PS_STATE.parcel) store.setParcel(null); };
  doc.addEventListener('ps:selection-changed', onSelectionChanged);

  store.restore();
  const app = createApp(MapBuddyPanel, { store, isMobile, doc });
  app.mount(host);
  store.loadAutomations();

  const openThen = (fn) => (...a) => { if (!state.open) store.open(); return fn(...a); };
  win.PV_MAP_BUDDY = {
    open: store.open,
    collapse: store.collapse,
    toggle: store.toggle,
    isOpen: () => state.open,
    ask: openThen((q) => store.send(q)),
    // An explicit "look at the map" from another control (the right-click menu).
    lookAtMap: openThen((question, userLabel) => store.startLook({ question: question || null, userLabel: userLabel || 'Describe this view' })),
    send: (t) => store.send(t),
    runCommands: store.runCommands,
    buildMapState: store.buildMapState,
  };

  function unmount() {
    app.unmount();
    stop.forEach((s) => s());
    win.removeEventListener('resize', onResize);
    doc.removeEventListener('ps:selection-changed', onSelectionChanged);
    win.PS_onParcelSelect = prevOnSelect;
    host.remove();
    css.remove();
    if (panelMap) panelMap.style.minWidth = origMinWidth != null ? origMinWidth : '';
    const tab = mcpTab();
    if (tab) tab.style.right = '';
    doc.body.classList.remove('mb-mobile-open');
    delete win.PV_MAP_BUDDY;
  }
  return { store, unmount };
}

/**
 * The island: tells MapBuddy (map-buddy.js) how to mount, which mounts the panel now if
 * the page already asked (MapBuddy.mount), or later when it does.
 */
export function mountMapBuddyIsland(win = globalThis) {
  const mb = win.MapBuddy;
  if (!mb || !mb.attach || !win.PV_MAP_BUDDY_COMMANDS) return null;   // Map Buddy isn't on the page
  return mb.attach((opts) => mountMapBuddy(opts, win));
}
