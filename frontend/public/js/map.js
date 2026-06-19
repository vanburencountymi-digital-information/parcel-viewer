/**
 * MapLibre map — Parcel Studio parcel viewer.
 *
 * Parcels render from the Martin MVT tile server (source "parcels",
 * source-layer "parcels", feature id promoted from the "pin" property).
 * A viewport-scoped GeoJSON index is hydrated from GET /parcels?bbox= to feed
 * the snapping engine, spatial selection tools, and parcel labels; full
 * parcel records come from GET /parcel/{id}.
 *
 * Selection architecture:
 *   - selectedPins[]          ordered array of PINs (preserves selection order)
 *   - selectedFeatureMap      Map<pin, {props, geometry}>
 *   - activeInfoPin           PIN shown in the info panel
 *   - featureState "selected" drives the shared highlight layer
 *   - featureState "activeInfo" drives the active-parcel layer
 */

(function () {
  const API_BASE = window.API_BASE || "";
  const MARTIN_URL = (window.PS_CONFIG && window.PS_CONFIG.MARTIN_URL) || "/tiles";
  const SOURCE_LAYER = "parcels";

  // Stamp the county name into the topbar from the manifest (county-config.js).
  if (window.COUNTY && COUNTY.name) {
    document.addEventListener("DOMContentLoaded", function () {
      var el = document.querySelector(".pv-brand-county");
      if (el) el.textContent = COUNTY.name;
    });
  }

  // ── Map instance ───────────────────────────────────────────────────────
  let map = null;
  let hoveredParcelId = null;

  // ── Selection state ────────────────────────────────────────────────────
  let selectedPins = [];
  let selectedFeatureMap = new Map();
  let activeInfoPin = null;
  let activeInfoIndex = 0;

  // ── Active spatial tool (IIFE-scope so map click handler can read it) ──
  let activeTool        = null;
  let bufferSeedPin     = null;
  let bufferSeedGeom    = null;
  let bufferPreviewPins = [];
  let bufferDebounceTimer = null;

  // Track Shift key state independently — more reliable than e.originalEvent.shiftKey in MapLibre v4
  let isShiftDown = false;
  document.addEventListener("keydown", (e) => { if (e.key === "Shift") isShiftDown = true; });
  document.addEventListener("keyup",   (e) => { if (e.key === "Shift") isShiftDown = false; });
  window.addEventListener("blur",      ()  => { isShiftDown = false; });

  window.PS_STATE = { parcel: null };

  // ── Status strip ───────────────────────────────────────────────────────
  const DEFAULT_STATUS = "Select a parcel on the map.";
  function setStatusStrip(text) {
    const el = document.getElementById("parcel-context");
    if (el) el.textContent = text;
  }

  // ── Live coordinate readout ──────────────────────────────────────────────
  // Bottom-right pill tracking the cursor. Click cycles the format; choice is
  // persisted. (Settings can drive this later via window.PV_COORDS.setFormat.)
  const COORD_FORMATS = ["dd", "dms", "spc"];
  // Michigan State Plane South (EPSG:6497, us-ft) — matches the Measurement tool.
  const MI_STATE_PLANE_DEF = "+proj=lcc +lat_0=41.5 +lon_0=-84.3666666666667 " +
    "+lat_1=42.1 +lat_2=43.6667 +x_0=4000000 +y_0=0 +ellps=GRS80 +units=us-ft +no_defs";
  const WGS84_DEF = "+proj=longlat +datum=WGS84 +no_defs";
  let _lastLngLat = null;

  function _coordFormat() {
    const f = localStorage.getItem("pv-coord-format");
    return COORD_FORMATS.indexOf(f) !== -1 ? f : "dd";
  }
  function _dd(v, pos, neg) { return Math.abs(v).toFixed(5) + "°" + (v >= 0 ? pos : neg); }
  function _dms(v, pos, neg) {
    let a = Math.abs(v), d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf), s = Math.round((mf - m) * 60);
    if (s === 60) { s = 0; m++; }
    if (m === 60) { m = 0; d++; }
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    return d + "°" + pad(m) + "'" + pad(s) + '"' + (v >= 0 ? pos : neg);
  }
  function _spc(lng, lat) {
    if (!window.proj4) return null;
    try {
      const xy = window.proj4(WGS84_DEF, MI_STATE_PLANE_DEF, [lng, lat]);
      return "N " + Math.round(xy[1]).toLocaleString() + "  E " + Math.round(xy[0]).toLocaleString() + " ft";
    } catch (_) { return null; }
  }
  function _formatLngLat(ll) {
    const lng = ll.lng, lat = ll.lat, f = _coordFormat();
    if (f === "dms") return _dms(lat, "N", "S") + "  " + _dms(lng, "E", "W");
    if (f === "spc") { const s = _spc(lng, lat); if (s) return s; }
    return _dd(lat, "N", "S") + "  " + _dd(lng, "E", "W");
  }
  function _renderCoords() {
    const el = document.getElementById("pv-coords");
    if (el && _lastLngLat) el.textContent = _formatLngLat(_lastLngLat);
  }
  function initCoordReadout() {
    const el = document.getElementById("pv-coords");
    if (!el || !map) return;
    map.on("mousemove", (e) => { _lastLngLat = e.lngLat; el.hidden = false; _renderCoords(); });
    map.on("mouseout", () => { el.hidden = true; });
    el.addEventListener("click", () => {
      const next = COORD_FORMATS[(COORD_FORMATS.indexOf(_coordFormat()) + 1) % COORD_FORMATS.length];
      localStorage.setItem("pv-coord-format", next);
      _renderCoords();
    });
    // Hook for a future Settings control.
    window.PV_COORDS = {
      setFormat: (f) => { if (COORD_FORMATS.indexOf(f) !== -1) { localStorage.setItem("pv-coord-format", f); _renderCoords(); } },
      getFormat: _coordFormat,
      formats: COORD_FORMATS.slice(),
    };
  }

  // ── Style ──────────────────────────────────────────────────────────────
  // The backend serves the MapLibre style with a {MARTIN_URL} placeholder in
  // the parcel tile URL; substitute the browser-facing Martin base here so the
  // same style works in dev (Vite proxy) and behind nginx.
  function absoluteMartinUrl() {
    if (/^https?:\/\//.test(MARTIN_URL)) return MARTIN_URL;
    return window.location.origin + MARTIN_URL;
  }

  async function resolveStyle() {
    const res = await fetch(API_BASE + "/style.json");
    const style = await res.json();
    const src = style.sources && style.sources.parcels;
    if (src && Array.isArray(src.tiles)) {
      src.tiles = src.tiles.map((t) => t.replace("{MARTIN_URL}", absoluteMartinUrl()));
    }
    return style;
  }

  // ── Switch selection layers from filter-based to featureState ──────────
  function setupSelectionLayers() {
    if (map.getLayer("parcels-selected-fill")) {
      map.setFilter("parcels-selected-fill", null);
      map.setPaintProperty("parcels-selected-fill", "fill-color", "#ffffff");
      map.setPaintProperty("parcels-selected-fill", "fill-opacity", [
        "case",
        ["boolean", ["feature-state", "activeInfo"], false], 0.10,
        ["boolean", ["feature-state", "selected"], false], 0.06,
        0
      ]);
    }
    if (map.getLayer("parcels-selected-line")) {
      map.setFilter("parcels-selected-line", null);
      map.setPaintProperty("parcels-selected-line", "line-color", [
        "case",
        ["boolean", ["feature-state", "activeInfo"], false], mapAccent("accent", "#A3473B"),
        "#0b1220"
      ]);
      map.setPaintProperty("parcels-selected-line", "line-width", [
        "case",
        ["boolean", ["feature-state", "activeInfo"], false], 4,
        ["boolean", ["feature-state", "selected"], false], 2.5,
        0
      ]);
      map.setPaintProperty("parcels-selected-line", "line-opacity", [
        "case",
        ["boolean", ["feature-state", "selected"], false], 1,
        ["boolean", ["feature-state", "activeInfo"], false], 1,
        0
      ]);
    }
  }

  // ── Selection management ───────────────────────────────────────────────
  function addToSelection(pin, props, geometry) {
    if (selectedPins.includes(pin)) return false;
    selectedPins.push(pin);
    selectedFeatureMap.set(pin, { props, geometry });
    if (map) map.setFeatureState({ source: "parcels", sourceLayer: SOURCE_LAYER, id: pin }, { selected: true });
    return true;
  }

  function removeFromSelection(pin) {
    const idx = selectedPins.indexOf(pin);
    if (idx === -1) return false;
    selectedPins.splice(idx, 1);
    selectedFeatureMap.delete(pin);
    if (map) map.setFeatureState({ source: "parcels", sourceLayer: SOURCE_LAYER, id: pin }, { selected: false, activeInfo: false });
    return true;
  }

  function clearSelectionAll() {
    for (const pin of selectedPins) {
      if (map) map.setFeatureState({ source: "parcels", sourceLayer: SOURCE_LAYER, id: pin }, { selected: false, activeInfo: false });
    }
    selectedPins = [];
    selectedFeatureMap.clear();
    activeInfoPin = null;
    activeInfoIndex = 0;
    updateSelectionBadge();
    hideInfoPanel();
    setStatusStrip(DEFAULT_STATUS);
    window.PS_STATE.parcel = null;
  }

  function setActiveInfoPin(pin) {
    if (activeInfoPin && map) {
      map.setFeatureState({ source: "parcels", sourceLayer: SOURCE_LAYER, id: activeInfoPin }, { activeInfo: false });
    }
    activeInfoPin = pin;
    if (pin && map) {
      map.setFeatureState({ source: "parcels", sourceLayer: SOURCE_LAYER, id: pin }, { activeInfo: true });
    }
  }

  // ── Reactive cartography: focus/dim spotlight (DIC-508) ────────────────────
  // When something is selected, the rest of the map recedes (rack-focus). Driven
  // off the existing `selected` feature-state, so it fires for user AND AI/Map
  // Buddy selections alike. The actual paint fn is assigned in init (it needs the
  // layer toggles + resting opacity); this is the module-level handle + the
  // effective-mode resolver.
  let _spotlightFn = null;
  function _effectiveReactions() {
    let mode = "subtle";
    try { mode = (window.PV_PREFS && PV_PREFS.getMapReactions && PV_PREFS.getMapReactions()) || "subtle"; } catch (_) {}
    if (mode === "full") {
      let reduced = false;
      try { reduced = document.documentElement.classList.contains("pv-a11y-motion") || matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) {}
      if (reduced) mode = "subtle";   // a11y: reduced-motion never gets cinematics
    }
    return mode;
  }

  function updateSelectionBadge() {
    // Notify listeners (Parcel Edits pane) whenever the selection set changes
    document.dispatchEvent(new CustomEvent("ps:selection-changed", {
      detail: { pins: [...selectedPins] },
    }));
    const selActions = document.getElementById("sel-actions");
    if (selActions) selActions.hidden = selectedPins.length === 0;
    if (_spotlightFn) _spotlightFn();   // re-evaluate the focus/dim spotlight
  }

  // ── Full parcel record fetch (property card / selection payload) ───────
  // Vector-tile features carry only the lightweight tile attributes and
  // tile-clipped geometry; the authoritative record comes from the API.
  const _parcelCache = new Map();   // id -> Feature

  async function fetchParcel(id) {
    if (_parcelCache.has(id)) return _parcelCache.get(id);
    const res = await fetch(API_BASE + "/parcel/" + id);
    if (!res.ok) throw new Error("Parcel fetch failed (" + res.status + ")");
    const feature = await res.json();
    _parcelCache.set(id, feature);
    return feature;
  }

  function invalidateParcelCache() { _parcelCache.clear(); }

  // ── Viewport parcel index hydration ────────────────────────────────────
  // Feeds PS_PARCEL_INDEX (snapping engine, selection tools, labels) from
  // GET /parcels?bbox= for the current viewport. Replaces ZIP-POC's full
  // client-side parcels.geojson load.
  const PARCEL_INDEX_MIN_ZOOM = 12;
  let _hydrateTimer = null;
  let _hydrateController = null;

  function scheduleParcelIndexRefresh() {
    clearTimeout(_hydrateTimer);
    _hydrateTimer = setTimeout(refreshParcelIndex, 350);
  }

  function refreshParcelIndex() {
    if (!map) return;
    if (map.getZoom() < PARCEL_INDEX_MIN_ZOOM) return;   // keep last index when zoomed out

    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(",");

    if (_hydrateController) _hydrateController.abort();
    _hydrateController = new AbortController();

    fetch(API_BASE + "/parcels?bbox=" + bbox, { signal: _hydrateController.signal })
      .then(r => r.json())
      .then(data => {
        parcelIndex = (data.features || []).filter(f => f.geometry);
        window.PS_PARCEL_INDEX = parcelIndex;
        document.dispatchEvent(new CustomEvent("ps:parcel-index-updated"));
      })
      .catch(() => { /* aborted or transient network error — keep last index */ });
  }

  // ── Tile invalidation (WebSocket) ──────────────────────────────────────
  // The backend broadcasts after commit/split/merge; force a parcel tile
  // reload so edits appear within ~2s.
  function connectInvalidationSocket() {
    let url = (window.PS_CONFIG && window.PS_CONFIG.WS_URL) || "";
    if (!url) {
      const proto = window.location.protocol === "https:" ? "wss://" : "ws://";
      url = proto + window.location.host + "/ws";
    }
    let socket;
    function open() {
      try { socket = new WebSocket(url); } catch (_) { return; }
      socket.onmessage = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg && msg.type === "parcels-updated") refreshParcelTiles();
      };
      socket.onclose = () => setTimeout(open, 3000);   // auto-reconnect
    }
    open();
  }

  function refreshParcelTiles() {
    if (!map) return;
    const src = map.getSource("parcels");
    if (!src) return;

    // Update the tile URL so any server-side caches see a new request
    const base = absoluteMartinUrl() + "/parcel_tiles/{z}/{x}/{y}";
    if (typeof src.setTiles === "function") {
      src.setTiles([base + "?v=" + Date.now()]);
    }

    // reload() re-requests every tile MapLibre has loaded across ALL zoom levels,
    // not just the current viewport. This covers wider-zoom tiles that
    // clearTiles()+update(transform) misses because update() only queues tiles
    // for the current zoom.
    const sc = map.style && map.style.sourceCaches && map.style.sourceCaches["parcels"];
    if (sc) {
      sc.reload();
      map.triggerRepaint();
    }

    invalidateParcelCache();
    refreshParcelIndex();
  }
  window.PS_refreshParcelTiles = refreshParcelTiles;

  // ── Hover (filter-based, unchanged) ───────────────────────────────────
  function setHoverFilter(pin) {
    if (!map || !map.getLayer("parcels-hover")) return;
    map.setFilter("parcels-hover", ["==", ["get", "pin"], pin || ""]);
  }

  // ── Theme (dark / light) ───────────────────────────────────────────────
  const CARTO_LIGHT = [
    "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    "https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
  ];
  const CARTO_DARK = [
    "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
  ];

  // ── Per-layer styling (DIC-460) ─────────────────────────────────────────────
  // styling.layers keys logical layers → { label, paint:{light,dark:{fill,stroke}},
  // choropleth:{…} }, so paint + choropleth scale to many layers, not just parcels.
  // Back-compat: an older manifest with top-level styling.parcels / styling.choropleth
  // is normalized into a single 'parcels' entry.
  function stylingLayers() {
    const st = (window.COUNTY && COUNTY.styling) || {};
    if (st.layers && typeof st.layers === "object") return st.layers;
    if (st.parcels || st.choropleth) {
      return { parcels: { label: "Parcels", paint: st.parcels || {}, choropleth: st.choropleth || null } };
    }
    return {};
  }

  // Map a logical layer id → the style-layer ids it drives. Parcels has bespoke ids
  // (incl. hover/labels); other vector layers follow the ${id}-fill / -line convention
  // used when they're added to the map.
  function mapLayersFor(id) {
    if (id === "parcels") return { fill: "parcels-fill", line: "parcels-line" };
    return { fill: id + "-fill", line: id + "-line" };
  }

  // The active choropleth for a layer's style, or null when off / empty.
  function choroplethConfig(style) {
    const ch = style && style.choropleth;
    if (!ch || !ch.enabled) return null;
    const hasCats = ch.mode !== "graduated" && Array.isArray(ch.categories) && ch.categories.length;
    const hasStops = ch.mode === "graduated" && Array.isArray(ch.stops) && ch.stops.length;
    return (hasCats || hasStops) ? ch : null;
  }

  // The key the ramp reads: the raw attribute, or — with transform 'classGroup' —
  // the first character of prop_class (Michigan major class: 1xx Ag, 4xx Res, …).
  function _choroKey(ch) {
    const get = ["to-string", ["get", ch.attribute]];
    return ch.transform === "classGroup" ? ["slice", get, 0, 1] : get;
  }

  // Build the MapLibre fill-color expression for a choropleth config. Theme-aware
  // (DIC-506): each category/stop may carry a `colorDark`; with no dark variant it
  // falls back to its light `color`.
  function choroplethFillExpr(ch, dark) {
    const hue = (o) => (dark && o.colorDark) ? o.colorDark : o.color;
    const fallback = (dark && ch.fallbackDark) || ch.fallback || "#cccccc";
    if (ch.mode === "graduated") {
      const stops = (ch.stops || []).slice().sort((a, b) => (a.min || 0) - (b.min || 0));
      const expr = ["step", ["to-number", ["get", ch.attribute], 0], hue(stops[0])];
      for (let i = 1; i < stops.length; i++) expr.push(stops[i].min, hue(stops[i]));
      return expr;
    }
    const expr = ["match", _choroKey(ch)];
    ch.categories.forEach((c) => { expr.push(String(c.value), hue(c)); });
    expr.push(fallback);
    return expr;
  }

  // A readable title for a legend section, derived from the attribute unless overridden.
  function _choroTitle(ch) {
    if (ch.legendTitle) return ch.legendTitle;
    if (ch.attribute === "prop_class" || ch.transform === "classGroup") return "Property class";
    if (ch.attribute === "gis_acres") return "Parcel size (acres)";
    return ch.attribute;
  }

  // Apply a layer's paint for the active theme: solid fill (or choropleth ramp) +
  // stroke. Each setPaintProperty is guarded so layers not yet on the map are skipped.
  function applyLayerPaint(id, style, dark) {
    if (!style) return;
    // Line/point layers are owned by pg-layers.js (casing, glow, dashes, radius
    // — DIC-503). Skip them here so this fill/stroke pass doesn't clobber them.
    if (style.line || style.point) return;
    const ids = mapLayersFor(id);
    const tone = ((style.paint && (dark ? style.paint.dark : style.paint.light)) || {});
    const ch = choroplethConfig(style);
    if (map.getLayer(ids.fill)) {
      map.setPaintProperty(ids.fill, "fill-color",
        ch ? choroplethFillExpr(ch, dark) : (tone.fill || (dark ? "#1e1a14" : "#FDF6E3")));
    }
    if (ids.line && map.getLayer(ids.line)) {
      map.setPaintProperty(ids.line, "line-color", tone.stroke || (dark ? "#b8a97a" : "#8a7a55"));
    }
  }

  // Build (or tear down) the floating legend. One section per choropleth-enabled
  // layer; sections = [{ title, rows:[{color,label}] }]. DOM-built so config
  // labels/colors are inserted as text/style, never as HTML.
  function updateChoroplethLegend(sections) {
    const mapEl = document.getElementById("map");
    let el = document.getElementById("choropleth-legend");
    if (!sections || !sections.length) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.id = "choropleth-legend";
      el.className = "choropleth-legend";
      el.setAttribute("role", "img");
      if (mapEl) mapEl.appendChild(el);
    }
    el.setAttribute("aria-label", sections.map((s) => s.title).join("; ") + " legend");
    el.textContent = "";
    sections.forEach((sec, i) => {
      if (i > 0) { const sep = document.createElement("div"); sep.className = "choropleth-legend-sep"; el.appendChild(sep); }
      const title = document.createElement("div");
      title.className = "choropleth-legend-title";
      title.textContent = sec.title;
      el.appendChild(title);
      sec.rows.forEach((r) => {
        const row = document.createElement("div");
        row.className = "choropleth-legend-row";
        const sw = document.createElement("span");
        sw.className = "choropleth-legend-swatch";
        sw.style.background = r.color;
        const lab = document.createElement("span");
        lab.className = "choropleth-legend-label";
        lab.textContent = r.label;
        row.appendChild(sw);
        row.appendChild(lab);
        el.appendChild(row);
      });
    });
  }

  // The legend sections for every choropleth-enabled styled layer. Theme-aware
  // swatches (DIC-506): use each row's `colorDark` in dark mode when present.
  function choroplethLegendSections(layers, dark) {
    const hue = (o) => (dark && o.colorDark) ? o.colorDark : o.color;
    const ids = Object.keys(layers);
    return ids.map((id) => {
      const ch = choroplethConfig(layers[id]);
      if (!ch) return null;
      const base = _choroTitle(ch);
      const title = ids.length > 1 ? ((layers[id].label || id) + " · " + base) : base;
      const rows = ch.mode === "graduated"
        ? (ch.stops || []).map((s) => ({ color: hue(s), label: s.label || ("≥ " + s.min) }))
        : (ch.categories || []).map((c) => ({ color: hue(c), label: c.label || c.value }));
      return { title, rows };
    }).filter(Boolean);
  }

  // Resolve a map accent token (DIC-505) off <html> for the active color scheme +
  // theme. Falls back if the CSS var is missing (e.g. a stale cached stylesheet).
  function mapAccent(role, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue("--map-" + role).trim();
      return v || fallback;
    } catch (_) { return fallback; }
  }

  function applyTheme(dark) {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    const moonIcon = document.getElementById("theme-icon-moon");
    const sunIcon  = document.getElementById("theme-icon-sun");
    if (moonIcon) moonIcon.hidden = dark;
    if (sunIcon)  sunIcon.hidden  = !dark;

    if (map) {
      const src = map.getSource("carto-positron");
      if (src) src.setTiles(dark ? CARTO_DARK : CARTO_LIGHT);

      // Per-layer paint (DIC-460): fill (solid or choropleth ramp) + stroke for
      // every styled layer, from COUNTY.styling.layers. Scales to many layers.
      const _layers = stylingLayers();
      Object.keys(_layers).forEach((id) => applyLayerPaint(id, _layers[id], dark));

      // Map accent chrome (DIC-505): the active color scheme drives selection,
      // hover, and the resting parcel stroke lean. Re-read here so a scheme change
      // ('pv-scheme-change' → applyTheme) re-tints the map live. SEMANTIC colors
      // (resting fill / class wash) are never touched by the accent.
      var _accent = mapAccent("accent", dark ? "#c9684f" : "#A3473B");
      var _accentStroke = mapAccent("accent-stroke", dark ? "#b8a97a" : "#8a7a55");
      if (map.getLayer("parcels-line")) map.setPaintProperty("parcels-line", "line-color", _accentStroke);
      if (map.getLayer("parcels-hover")) map.setPaintProperty("parcels-hover", "line-color", _accent);
      if (map.getLayer("parcels-selected-line")) {
        map.setPaintProperty("parcels-selected-line", "line-color", [
          "case", ["boolean", ["feature-state", "activeInfo"], false], _accent, "#0b1220",
        ]);
      }
      // Label colors stay theme-driven (parcels-labels is hidden — DIC-504 — kept
      // themed in case it's re-enabled).
      if (map.getLayer("parcels-labels")) {
        map.setPaintProperty("parcels-labels", "text-color", dark ? "#c8b89a" : "#1f2937");
        map.setPaintProperty("parcels-labels", "text-halo-color", dark ? "#111009" : "#ffffff");
      }

      // Legend: one section per choropleth-enabled layer.
      updateChoroplethLegend(choroplethLegendSections(_layers, dark));
    }
    localStorage.setItem("pv-theme", dark ? "dark" : "light");

    // Re-render an open parcel popup so theme-dependent SVG (AV chart) re-themes
    // and keeps passing contrast in the new theme (DIC-385 follow-up).
    rerenderOpenParcel();
  }

  // County default theme (COUNTY.styling.theme, DIC-460): 'light'/'dark' force it,
  // anything else (or unset) → the OS preference.
  function countyThemeDefault(prefersDark) {
    const t = window.COUNTY && COUNTY.styling && COUNTY.styling.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return prefersDark;
  }

  function initTheme() {
    const saved = localStorage.getItem("pv-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const dark = saved ? saved === "dark" : countyThemeDefault(prefersDark);
    applyTheme(dark);

    const btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.addEventListener("click", () => {
        const isDark = document.documentElement.getAttribute("data-theme") === "dark";
        applyTheme(!isDark);
      });
    }
  }

  // Programmatic theme control (MapBuddy AI and other callers).
  window.PV_THEME = {
    set: function (dark) { applyTheme(!!dark); },
    get: function () { return document.documentElement.getAttribute("data-theme") === "dark"; },
  };

  // ── Map init ───────────────────────────────────────────────────────────
  async function initMap() {
    const style = await resolveStyle();
    const cmap = (window.COUNTY && COUNTY.map) || {};
    const EXTENT = cmap.extent || [[-86.33, 42.06], [-85.76, 42.43]];

    map = new maplibregl.Map({
      container: "map",
      style: style,
      center: cmap.center || [-86.03, 42.24],
      zoom: cmap.zoom != null ? cmap.zoom : 9,
      preserveDrawingBuffer: true,
      boxZoom: false,  // we use our own box-select; default shift+drag zoom conflicts with shift-click
    });

    initCoordReadout();

    map.on("load", () => {
      requestAnimationFrame(() => {
        map.resize();
        const cam = map.cameraForBounds(EXTENT, { padding: 0 });
        map.flyTo({ center: cam.center, zoom: cam.zoom + 0.5, duration: 1400, curve: 1.4, essential: true });
      });

      // Re-apply theme now that map sources are available
      const savedTheme = localStorage.getItem("pv-theme");
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      applyTheme(savedTheme ? savedTheme === "dark" : countyThemeDefault(prefersDark));

      // Expose map instance for drawing modules and MapControlAPI
      window.PS_MAP = map;

      // Re-tint the map when the color scheme changes (DIC-505). admin-menu's
      // setScheme() flips data-scheme then dispatches this; applyTheme re-reads
      // the --map-* tokens for the new scheme.
      window.addEventListener("pv-scheme-change", function () {
        applyTheme(document.documentElement.getAttribute("data-theme") === "dark");
      });

      setupSelectionLayers();
      setupBufferLayers();
      setupAnnotationLayers();

      // Hydrate the viewport parcel index now and on every move
      refreshParcelIndex();
      map.on("moveend", scheduleParcelIndexRefresh);

      // Live tile invalidation after commits/splits/merges
      connectInvalidationSocket();

      // Click — drawing tool intercepts first; buffer sets seed; shift-click toggles; normal replaces.
      // Tile features carry clipped geometry, so resolve the full record first.
      map.on("click", "parcels-fill", (e) => {
        const feature = e.features[0];
        // Drawing tools handle their own click via map.on('click') in drawing-tools.js
        if (window.PS_STATE && window.PS_STATE.activeDrawTool) return;
        const shift = isShiftDown || !!(e.originalEvent && e.originalEvent.shiftKey);
        const id = feature.properties.id;
        if (id == null) return;
        fetchParcel(id)
          .then((full) => {
            if (activeTool === "buffer") {
              handleBufferSeedClick(full);
              return;
            }
            selectParcel(full.properties, full.geometry, shift);
          })
          .catch((err) => console.warn("parcel fetch:", err));
      });

      // Layer toggles
      const origFillOpacity = map.getPaintProperty("parcels-fill", "fill-opacity");
      const origLineColor   = map.getPaintProperty("parcels-line", "line-color");

      const aerialToggle = document.getElementById("toggle-aerial");
      const zoningToggle = document.getElementById("toggle-zoning");

      // Resting fill opacity (DIC-506): when the property-class wash (a choropleth
      // on the parcels layer) is the resting fill, render it subtle (~0.16) so
      // labels, selection, hover, and overlays read clearly on top. No wash → the
      // original cream/dark opacity from the style.
      function restingFillOpacity() {
        const ch = choroplethConfig((stylingLayers().parcels) || {});
        return (ch && ch.opacity != null) ? ch.opacity : origFillOpacity;
      }

      // Focus/dim spotlight painter (DIC-508). When a parcel is selected (user or
      // AI), the non-selected parcels recede (fill + line) and the subject keeps
      // its wash + accent outline. Subtle = instant; Full = animated transition
      // (capped to instant under reduced-motion). Off = no dim.
      _spotlightFn = function () {
        if (!map || !map.getLayer("parcels-fill")) return;
        const mode = _effectiveReactions();
        const active = mode !== "off" && selectedPins.length > 0;
        const dur = mode === "full" ? 320 : 0;
        try {
          map.setPaintProperty("parcels-fill", "fill-opacity-transition", { duration: dur });
          map.setPaintProperty("parcels-line", "line-opacity-transition", { duration: dur });
        } catch (_) {}
        const normalFill = zoningToggle.checked && !aerialToggle.checked;
        if (normalFill) {
          map.setPaintProperty("parcels-fill", "fill-opacity",
            active
              ? ["case", ["boolean", ["feature-state", "selected"], false], Math.max(restingFillOpacity(), 0.24), 0.04]
              : restingFillOpacity());
        }
        map.setPaintProperty("parcels-line", "line-opacity",
          active
            ? ["case", ["boolean", ["feature-state", "selected"], false], 1, 0.18]
            : 0.85);
      };

      function updateZoningOpacity() {
        const zoningOn = zoningToggle.checked;
        const aerialOn = aerialToggle.checked;
        if (!zoningOn) {
          map.setPaintProperty("parcels-fill", "fill-opacity", 0);
        } else if (aerialOn) {
          map.setPaintProperty("parcels-fill", "fill-opacity", 0.25);
        }
        // Normal-mode resting fill + the focus/dim spotlight are owned by _spotlightFn.
        _spotlightFn();
      }

      // Programmatic / AI focus handle (DIC-508). Selecting parcels already
      // triggers the spotlight via updateSelectionBadge; Map Buddy focuses by
      // selecting (existing bridge). This re-applies on a "Map reactions" change.
      window.PS_MAP_FOCUS = {
        refresh: function () { if (_spotlightFn) _spotlightFn(); },
        mode: function () { return _effectiveReactions(); },
      };

      aerialToggle.addEventListener("change", (e) => {
        map.setLayoutProperty("mi-aerial", "visibility", e.target.checked ? "visible" : "none");
        if (window.PS_MAP_PANEL) window.PS_MAP_PANEL.layers.aerial = e.target.checked;
        updateZoningOpacity();
      });

      // Apply saved "Default basemap = Aerial" preference (Settings) on load.
      try {
        if (localStorage.getItem("pv-basemap") === "aerial" && !aerialToggle.checked) {
          aerialToggle.checked = true;
          aerialToggle.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } catch (_) {}

      zoningToggle.addEventListener("change", (e) => {
        // Parcels checkbox controls only the parcel fill/line. Parcel LABELS are
        // owned by the "Parcel Labels" tool (DIC-504) — the Parcels toggle no
        // longer force-shows the legacy parcels-labels layer (kept hidden).
        if (e.target.checked) {
          map.setPaintProperty("parcels-line", "line-color", mapAccent("accent-stroke", origLineColor));
        } else {
          map.setPaintProperty("parcels-line", "line-color", "rgba(255,255,255,0.65)");
        }
        if (window.PS_MAP_PANEL) window.PS_MAP_PANEL.layers.zoning = e.target.checked;
        updateZoningOpacity();
      });

      // Apply the resting fill opacity now (so the class wash loads subtle, not at
      // the heavier default cream opacity — DIC-506).
      updateZoningOpacity();

      const HOVER_MIN_ZOOM = 14;

      map.on("mousemove", "parcels-fill", (e) => {
        if (map.getZoom() < HOVER_MIN_ZOOM) return;
        if (!e.features.length) return;
        const pin = e.features[0].properties.pin || e.features[0].properties.PIN;
        if (pin !== hoveredParcelId) {
          hoveredParcelId = pin;
          setHoverFilter(pin);
        }
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "parcels-fill", () => {
        hoveredParcelId = null;
        setHoverFilter(null);
        map.getCanvas().style.cursor = "";
      });

      map.on("zoom", () => {
        if (map.getZoom() < HOVER_MIN_ZOOM && hoveredParcelId) {
          hoveredParcelId = null;
          setHoverFilter(null);
          map.getCanvas().style.cursor = "";
        }
      });
    });
  }

  // ── Geometry helpers ───────────────────────────────────────────────────
  function computeBounds(geometry) {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    const traverse = (arr) => {
      if (typeof arr[0] === "number") {
        if (arr[0] < minLng) minLng = arr[0];
        if (arr[1] < minLat) minLat = arr[1];
        if (arr[0] > maxLng) maxLng = arr[0];
        if (arr[1] > maxLat) maxLat = arr[1];
      } else {
        arr.forEach(traverse);
      }
    };
    traverse(geometry.coordinates);
    return [[minLng, minLat], [maxLng, maxLat]];
  }

  function computeCentroid(geometry) {
    const b = computeBounds(geometry);
    return [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
  }

  // A point guaranteed to lie INSIDE the parcel (unlike computeCentroid's
  // bbox-center, which can fall outside concave/multipart parcels). Used for the
  // popup coordinate display. Falls back to the bbox center if turf is absent.
  // NOTE: this is a client-side representative point; the authoritative point
  // will come from the DB (ST_PointOnSurface) once available — see DIC-374.
  function representativePoint(geometry) {
    if (!geometry) return null;
    try {
      if (window.turf && turf.pointOnFeature) {
        return turf.pointOnFeature({ type: "Feature", geometry: geometry }).geometry.coordinates;
      }
    } catch (_) { /* fall through */ }
    return computeCentroid(geometry);
  }

  // ── Parcel info panel ──────────────────────────────────────────────────
  const infoPanel     = document.getElementById("parcel-info-panel");
  const infoBody      = infoPanel ? infoPanel.querySelector(".parcel-info-body") : null;
  const infoHeader    = infoPanel ? infoPanel.querySelector(".parcel-info-header") : null;
  const infoClose     = infoPanel ? infoPanel.querySelector(".parcel-info-close") : null;
  const infoReopenTab = document.getElementById("parcel-info-reopen-tab");
  let   infoPanelCollapsed = false;

  // ── Focus management + theme re-render for the parcel region (DIC-385) ──
  let _focusInfoPanelOnShow = false;   // set when opened via the keyboard search path
  let _lastFocusBeforeInfo  = null;    // element to restore focus to on close
  let _lastParcelArgs       = null;    // [pin, p, geometry] for re-render on theme toggle

  // Re-render the open parcel popup (theme change, area-units change, etc.)
  // without stealing focus.
  function rerenderOpenParcel() {
    if (infoPanel && !infoPanel.hidden && _lastParcelArgs) {
      const wasFocus = _focusInfoPanelOnShow;
      _focusInfoPanelOnShow = false;
      showParcelInfo(_lastParcelArgs.pin, _lastParcelArgs.p, _lastParcelArgs.geometry);
      _focusInfoPanelOnShow = wasFocus;
    }
  }

  // Display preferences surfaced in the Settings modal (admin-menu.js).
  window.PV_PREFS = {
    getAreaUnits: function () { try { return localStorage.getItem("pv-area-units") || "acres"; } catch (_) { return "acres"; } },
    setAreaUnits: function (u) {
      try { localStorage.setItem("pv-area-units", u === "sqft" ? "sqft" : "acres"); } catch (_) {}
      rerenderOpenParcel();
    },
    getBasemap: function () {
      try { const bm = localStorage.getItem("pv-basemap"); if (bm) return bm; } catch (_) {}
      return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    },
    setBasemap: function (v) {
      try { localStorage.setItem("pv-basemap", v); } catch (_) {}
      const aerial = document.getElementById("toggle-aerial");
      if (v === "aerial") {
        if (aerial && !aerial.checked) { aerial.checked = true; aerial.dispatchEvent(new Event("change", { bubbles: true })); }
      } else {
        if (aerial && aerial.checked) { aerial.checked = false; aerial.dispatchEvent(new Event("change", { bubbles: true })); }
        applyTheme(v === "dark");
      }
    },
    // Cinematic "orbit" after a search arrival. Default on; power users can
    // disable the 360° spin (kept fly-in) in Settings. See PS_cinematicFlyTo.
    getCinematicOrbit: function () {
      try { return localStorage.getItem("pv-cinematic-orbit") !== "0"; } catch (_) { return true; }
    },
    setCinematicOrbit: function (on) {
      try { localStorage.setItem("pv-cinematic-orbit", on ? "1" : "0"); } catch (_) {}
    },
    // Reactive cartography (DIC-508): focus/dim spotlight + AI map reactions.
    // 'off' | 'subtle' | 'full'. Default 'subtle'; reduced-motion caps Full→Subtle.
    getMapReactions: function () {
      try { var v = localStorage.getItem("pv-map-reactions"); return (v === "off" || v === "full") ? v : "subtle"; } catch (_) { return "subtle"; }
    },
    setMapReactions: function (v) {
      if (v !== "off" && v !== "full") v = "subtle";
      try { localStorage.setItem("pv-map-reactions", v); } catch (_) {}
      try { if (window.PS_MAP_FOCUS) window.PS_MAP_FOCUS.refresh(); } catch (_) {}
    },
  };

  function collapseInfoPanel() {
    infoPanelCollapsed = true;
    if (infoPanel) infoPanel.hidden = true;
    const navEl = document.getElementById("parcel-info-nav");
    if (navEl) navEl.hidden = true;
    if (infoReopenTab) infoReopenTab.hidden = false;
    if (window.PV_MOBILE_TABS) window.PV_MOBILE_TABS.refresh();
  }

  function expandInfoPanel() {
    infoPanelCollapsed = false;
    if (infoReopenTab) infoReopenTab.hidden = true;
    if (infoPanel) infoPanel.hidden = false;
    if (window.PV_MOBILE_TABS) window.PV_MOBILE_TABS.refresh();
  }

  function hideInfoPanel() {
    infoPanelCollapsed = false;
    if (infoPanel) infoPanel.hidden = true;
    if (infoReopenTab) infoReopenTab.hidden = true;
    const navEl = document.getElementById("parcel-info-nav");
    if (navEl) navEl.hidden = true;
    if (window.PV_MOBILE_TABS) window.PV_MOBILE_TABS.refresh();
  }

  // ── Field tooltip — single fixed-position div, avoids overflow-y:auto clipping ──
  const _tip = document.createElement("div");
  _tip.id = "parcel-tip";
  _tip.setAttribute("aria-hidden", "true");
  document.body.appendChild(_tip);

  if (infoBody) {
    infoBody.addEventListener("mouseover", (e) => {
      const el = e.target.closest("[data-tip]");
      if (!el) return;
      _tip.textContent = el.dataset.tip;
      _tip.classList.add("parcel-tip-visible");
    });
    infoBody.addEventListener("mousemove", (e) => {
      if (!_tip.classList.contains("parcel-tip-visible")) return;
      // Position above the cursor, clamped to viewport
      const tw = _tip.offsetWidth || 220;
      const th = _tip.offsetHeight || 40;
      let x = e.clientX + 12;
      let y = e.clientY - th - 8;
      if (x + tw > window.innerWidth  - 8) x = e.clientX - tw - 12;
      if (y < 8) y = e.clientY + 20;
      _tip.style.left = x + "px";
      _tip.style.top  = y + "px";
    });
    infoBody.addEventListener("mouseout", (e) => {
      if (!e.target.closest("[data-tip]")) return;
      _tip.classList.remove("parcel-tip-visible");
    });
  }

  if (infoClose) {
    // The card's × deselects (DIC-508 follow-up): clears the selection so the
    // focus/dim spotlight lifts and the map returns to normal. (Panel-vs-panel
    // mutual exclusion still uses collapseInfoPanel, which keeps the selection.)
    infoClose.addEventListener("click", () => {
      clearSelectionAll();
      if (_lastFocusBeforeInfo && document.contains(_lastFocusBeforeInfo)) _lastFocusBeforeInfo.focus();
    });
  }

  if (infoReopenTab) {
    infoReopenTab.addEventListener("click", () => {
      expandInfoPanel();
      if (infoPanel) infoPanel.focus();
    });
  }

  // Drag
  if (infoHeader && infoPanel) {
    let dragging = false, startX, startY, startLeft, startTop;
    infoHeader.addEventListener("pointerdown", (e) => {
      if (e.target === infoClose) return;
      dragging = true;
      infoHeader.setPointerCapture(e.pointerId);
      const rect = infoPanel.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      infoPanel.style.bottom = "auto";
      infoPanel.style.left = startLeft + "px";
      infoPanel.style.top  = startTop + "px";
    });
    infoHeader.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const panel = infoPanel.parentElement.getBoundingClientRect();
      const newLeft = Math.max(0, Math.min(panel.width  - infoPanel.offsetWidth,  startLeft - panel.left + e.clientX - startX));
      const newTop  = Math.max(0, Math.min(panel.height - infoPanel.offsetHeight, startTop  - panel.top  + e.clientY - startY));
      infoPanel.style.left = newLeft + "px";
      infoPanel.style.top  = newTop  + "px";
    });
    infoHeader.addEventListener("pointerup",     () => { dragging = false; });
    infoHeader.addEventListener("pointercancel", () => { dragging = false; });
  }

  // Nav buttons and keyboard cycling
  const navEl    = document.getElementById("parcel-info-nav");
  const navPrev  = document.getElementById("parcel-nav-prev");
  const navNext  = document.getElementById("parcel-nav-next");
  const navLabel = document.getElementById("parcel-nav-label");
  const navFly   = document.getElementById("parcel-fly-btn");

  if (navPrev) navPrev.addEventListener("click", () => cycleParcel(-1));
  if (navNext) navNext.addEventListener("click", () => cycleParcel(1));
  if (navFly)  navFly.addEventListener("click",  () => flyToActiveParcel(true));

  document.addEventListener("keydown", (e) => {
    if (!infoPanel || infoPanel.hidden) return;
    if (selectedPins.length < 2) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "ArrowLeft")  { e.preventDefault(); cycleParcel(-1); }
    if (e.key === "ArrowRight") { e.preventDefault(); cycleParcel(1); }
  });

  function cycleParcel(direction) {
    if (selectedPins.length === 0) return;
    const newIdx = ((activeInfoIndex + direction) % selectedPins.length + selectedPins.length) % selectedPins.length;
    showParcelAtIndex(newIdx);
  }

  function flyToActiveParcel(force) {
    if (!map || !activeInfoPin) return;
    const entry = selectedFeatureMap.get(activeInfoPin);
    if (!entry) return;
    const [lng, lat] = computeCentroid(entry.geometry);
    if (force || !map.getBounds().contains([lng, lat])) {
      map.easeTo({ center: [lng, lat], duration: 600 });
    }
  }

  // ── Info display ───────────────────────────────────────────────────────
  // County-specific label maps now live in county-config.js (window.COUNTY).
  const PROP_CLASS_LABELS  = (window.COUNTY && COUNTY.labels && COUNTY.labels.propClass)  || {};
  const SCHOOL_DIST_LABELS = (window.COUNTY && COUNTY.labels && COUNTY.labels.schoolDist) || {};

  // Field layout matches the geo.parcels / assessing.vbc_parcels payload
  // returned by GET /parcel/{id}.
  function showParcelInfo(pin, p, geometry) {
    if (!infoPanel || !infoBody) return;
    _lastParcelArgs = { pin, p, geometry };   // for re-render on theme toggle

    // Representative interior point (lng/lat), formatted to the active readout
    // format (DD / DMS / State Plane).
    const repPt = representativePoint(geometry);
    const coordRow = repPt
      ? `<div class="parcel-info-row"><span class="parcel-info-label" data-tip="A point inside the parcel boundary. Format follows the coordinate readout at bottom-right (click it to change).">Center</span><span class="parcel-info-value">${_formatLngLat({ lng: repPt[0], lat: repPt[1] })}</span></div>`
      : "";

    const fmt   = (n) => n != null ? "$" + parseInt(n).toLocaleString() : "—";
    const dash  = (v) => (v != null && v !== "") ? v : "—";
    const fmtAc = (v) => {
      if (v == null) return "—";
      const ac = parseFloat(v);
      if (!ac) return "—";
      const sqft = Math.round(ac * 43560).toLocaleString();
      let units = null;
      try { units = localStorage.getItem("pv-area-units"); } catch (_) {}
      if (units === "sqft") return `${sqft} sq ft`;
      const acStr = ac.toFixed(2) + " ac";
      if (ac >= 1) return acStr;
      return `${acStr} (${sqft} sq ft)`;
    };

    const siteAddr = [p.prop_street || p.PCOMBINED, p.prop_city].filter(Boolean).join(", ");
    const ownerMail = [
      p.owner_street || "",
      [p.owner_city || "", p.owner_state || ""].filter(Boolean).join(" "),
      p.owner_zip || ""
    ].filter(Boolean).join(", ");
    const homestead = p.homestead != null ? parseFloat(p.homestead) : null;
    const classCode = p.prop_class ? String(p.prop_class).trim() : null;
    const classLabel = classCode && PROP_CLASS_LABELS[classCode];
    const classDisplay = classCode ? (classLabel ? `${classCode} – ${classLabel}` : classCode) : "—";
    const schoolCode = p.school_dist ? String(p.school_dist).trim() : null;
    const schoolName = schoolCode && SCHOOL_DIST_LABELS[schoolCode];
    const schoolDisplay = schoolName || (schoolCode ? schoolCode : "—");
    const schoolTip = schoolName ? `District code: ${schoolCode}` : "School district code";
    const legalDesc = p.ps_legal_description || p.legal_description || "";

    const av0 = p.assessed_value      != null ? parseInt(p.assessed_value)      : null;
    const tv0 = p.taxable_value       != null ? parseInt(p.taxable_value)       : null;
    const av1 = p.prev_assessed_value != null ? parseInt(p.prev_assessed_value) : null;
    const tv1 = p.prev_taxable_value  != null ? parseInt(p.prev_taxable_value)  : null;

    const histVals = [p.assessed_value_yr0, p.assessed_value_yr1, p.assessed_value_yr2,
                      p.assessed_value_yr3, p.assessed_value_yr4]
      .map(v => v != null ? parseInt(v) : null);

    // Build a compact SVG bar chart for AV history.
    // histVals is newest-first (yr0…yr4); reverse so bars read oldest→newest left to right.
    const avChartHtml = (() => {
      const vals = histVals.slice().reverse();
      const validVals = vals.filter(v => v != null);
      if (validVals.length === 0) return '<div class="parcel-info-row"><span class="parcel-info-label">AV History</span><span class="parcel-info-value">—</span></div>';
      const curYear = new Date().getFullYear();
      const maxVal = Math.max(...validVals);
      const W = 240, H = 74, labelH = 13, valueH = 11, barAreaH = H - labelH - valueH;
      const colW = W / vals.length, barW = colW * 0.55;
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      const barTop = dark ? "#6b5a38" : "#CBAB7A";
      const barBot = dark ? "#4a3e26" : "#B58D4A";
      // WCAG 2.1 AA (DIC-376): both label fills must clear 4.5:1 in each theme.
      const lblClr = dark ? "#b09a7a" : "#6D5C52";  // value labels ($k)
      const yrClr  = dark ? "#b9bdc4" : "#4b5563";  // year labels
      const bars = vals.map((v, i) => {
        const cx = colW * i + colW / 2;
        const yr = curYear - (vals.length - 1 - i);
        if (v == null) return `<text x="${cx}" y="${H - 2}" text-anchor="middle" font-size="9" fill="${yrClr}">${yr}</text>`;
        const bh = Math.max(3, Math.round((v / maxVal) * barAreaH));
        const bx = cx - barW / 2, by = valueH + barAreaH - bh;
        const lbl = '$' + Math.round(v / 1000) + 'k';
        return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="url(#av-bar-grad)" rx="2"/>` +
               `<text x="${cx}" y="${(by - 2).toFixed(1)}" text-anchor="middle" font-size="9" fill="${lblClr}">${lbl}</text>` +
               `<text x="${cx}" y="${H - 2}" text-anchor="middle" font-size="9" fill="${yrClr}">${yr}</text>`;
      }).join('');
      const defs = `<defs><linearGradient id="av-bar-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${barTop}"/><stop offset="100%" stop-color="${barBot}"/></linearGradient></defs>`;
      return `<div style="margin-top:6px"><span class="parcel-info-label" data-tip="5-year assessed value history (oldest to newest)">AV History</span>` +
             `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;margin-top:3px" aria-label="AV history chart">${defs}${bars}</svg></div>`;
    })();

    const provenance = p.source && p.source !== "migration"
      ? `<div class="parcel-info-row"><span class="parcel-info-label" data-tip="How this geometry row was created (COGO commit, split, merge, boundary adjustment, or original shapefile migration)">Geometry</span><span class="parcel-info-value">${dash(p.source)}</span></div>`
      : "";

    infoBody.innerHTML =
      `<div class="parcel-info-pin">${pin}</div>` +
      `<div class="parcel-info-zoning">${dash(p.municipality)}</div>` +
      `<hr class="parcel-info-divider">` +

      `<div class="parcel-info-section-title">Parcel</div>` +
      `<div class="parcel-info-row"><span class="parcel-info-label">Address</span><span class="parcel-info-value">${dash(siteAddr)}</span></div>` +
      `<div class="parcel-info-row"><span class="parcel-info-label" data-tip="Parcel area calculated from the mapped boundary">Area</span><span class="parcel-info-value">${fmtAc(p.gis_acres ?? p.acres)}</span></div>` +
      coordRow +
      `<div class="parcel-info-row"><span class="parcel-info-label" data-tip="Michigan STC property classification code and description">Class</span><span class="parcel-info-value">${classDisplay}</span></div>` +
      `<div class="parcel-info-row"><span class="parcel-info-label" data-tip="${schoolTip}">School</span><span class="parcel-info-value">${schoolDisplay}</span></div>` +
      provenance +
      `<hr class="parcel-info-divider">` +

      `<div class="parcel-info-section-title">Owner</div>` +
      `<div class="parcel-info-row"><span class="parcel-info-label">Name</span><span class="parcel-info-value">${dash(p.owner_name)}</span></div>` +
      `<div class="parcel-info-row"><span class="parcel-info-label" data-tip="Owner's mailing address as recorded in the tax roll">Mailing</span><span class="parcel-info-value" style="white-space:normal;word-break:break-word">${dash(ownerMail)}</span></div>` +
      `<hr class="parcel-info-divider">` +

      `<div class="parcel-info-section-title">Assessed Values` +
        `<button class="pv-info-btn" data-info="assess" data-pin="${pin}" data-tip="About property assessment" aria-label="About property assessment">` +
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>` +
        `</button></div>` +
      `<table class="parcel-info-table">` +
      `<thead><tr><th></th><th>Current</th><th>Prior</th></tr></thead>` +
      `<tbody>` +
      `<tr><td data-tip="Assessed Value — set by the assessor at 50% of estimated True Cash Value (TCV)">AV</td><td>${fmt(av0)}</td><td>${fmt(av1)}</td></tr>` +
      `<tr><td data-tip="Taxable Value — the value taxes are actually levied on. Capped each year at the lesser of SEV or prior year TV plus the inflation rate (Michigan Proposal A).">TV</td><td>${fmt(tv0)}</td><td>${fmt(tv1)}</td></tr>` +
      `<tr><td data-tip="True Market Value (estimated) — calculated as 2× Assessed Value">TMV</td><td>${fmt(av0 != null ? av0 * 2 : null)}</td><td>${fmt(av1 != null ? av1 * 2 : null)}</td></tr>` +
      `</tbody></table>` +
      avChartHtml +
      `<div class="parcel-info-row" style="margin-top:6px"><span class="parcel-info-label" data-tip="Principal Residence Exemption — reduces taxable value for the owner's primary home. 100% = full exemption; 0% = no exemption (rental, vacant, or non-homestead)">PRE</span><span class="parcel-info-value">${homestead != null ? homestead + "%" : "—"}</span></div>` +
      `<hr class="parcel-info-divider">` +

      `<div class="parcel-info-section-title">Tax Description` +
        `<button class="pv-info-btn" data-info="tax" data-pin="${pin}" data-tip="About this tax description" aria-label="About this tax description">` +
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>` +
        `</button></div>` +
      `<div class="parcel-info-desc">${dash(legalDesc)}</div>` +

      // Parcel actions — handled by the .pv-ptool / [data-bm-toggle] delegation in admin-menu.js
      `<div class="parcel-info-actions">` +
        (() => {
          const on = (window.PV_BOOKMARKS && p.id != null) ? window.PV_BOOKMARKS.has(p.id) : false;
          return `<button type="button" class="pv-bm-toggle${on ? " is-on" : ""}" data-bm-toggle aria-pressed="${on}" title="${on ? "Remove bookmark" : "Bookmark this parcel"}">` +
            `<span class="pv-bm-star" aria-hidden="true">★</span>` +
            `<span class="pv-bm-label">${on ? "Bookmarked" : "Bookmark"}</span>` +
          `</button>`;
        })() +
        `<button class="pv-ptool" data-ptool="streetview" data-pin="${pin}">` +
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="12" cy="10" r="3"/><path d="M12 2a8 8 0 0 0-8 8c0 5.4 8 12 8 12s8-6.6 8-12a8 8 0 0 0-8-8z"/></svg>` +
          `<span>Street View</span>` +
        `</button>` +
        `<button class="pv-ptool" data-ptool="packet" data-pin="${pin}">` +
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>` +
          `<span>Generate Parcel Packet</span>` +
        `</button>` +
        `<button class="pv-ptool" data-ptool="compare" data-pin="${pin}">` +
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/></svg>` +
          `<span>Compare Parcels</span>` +
        `</button>` +
      `</div>`;

    if (!infoPanelCollapsed) {
      infoPanel.hidden = false;
      // Mobile: Parcel Info and Map Controls are mutually exclusive top
      // dropdowns — selecting a parcel closes Map Controls so they don't stack.
      if (window.innerWidth <= 640) {
        const mcp = document.getElementById("map-control-panel");
        if (mcp) mcp.hidden = true;
      }
      if (window.PV_MOBILE_TABS) window.PV_MOBILE_TABS.refresh();
      // When opened via the keyboard search path, move focus into the region so
      // screen-reader users land on the new parcel content (DIC-385).
      if (_focusInfoPanelOnShow) { infoPanel.focus(); _focusInfoPanelOnShow = false; }
    }
  }

  function updateInfoPanelNav() {
    if (!navEl) return;
    const multi = selectedPins.length > 1;
    navEl.hidden = !multi;
    if (multi && navLabel) {
      navLabel.textContent = `${activeInfoIndex + 1} of ${selectedPins.length}`;
    }
  }

  function showParcelAtIndex(idx) {
    if (selectedPins.length === 0) return;
    idx = Math.max(0, Math.min(selectedPins.length - 1, idx));
    activeInfoIndex = idx;

    const pin   = selectedPins[idx];
    const entry = selectedFeatureMap.get(pin);
    if (!entry) return;

    setActiveInfoPin(pin);
    updateInfoPanelNav();

    const p = entry.props;
    showParcelInfo(pin, p, entry.geometry);

    const [cLng, cLat] = entry.geometry ? computeCentroid(entry.geometry) : [null, null];
    const pBounds      = entry.geometry ? computeBounds(entry.geometry) : [[null,null],[null,null]];

    window.PS_STATE.parcel = {
      id:           p.id ?? null,
      pin,
      acres:        p.gis_acres != null ? parseFloat(p.gis_acres) : (p.acres != null ? parseFloat(p.acres) : null),
      owner_name:   p.owner_name || null,
      site_address: p.prop_street || p.PCOMBINED || null,
      municipality: p.municipality || null,
      source:       p.source || null,
      cogo_legs:    p.cogo_legs || null,
      centroid:     [cLng, cLat],
      bbox:         [pBounds[0][0], pBounds[0][1], pBounds[1][0], pBounds[1][1]], // [w, s, e, n]
      geometry:     entry.geometry || null,
    };

    const n = selectedPins.length;
    const acresStr = window.PS_STATE.parcel.acres != null ? window.PS_STATE.parcel.acres.toFixed(2) : "?";
    setStatusStrip(n > 1
      ? `${n} parcels selected — viewing ${pin}`
      : `Parcel ${pin} · ${p.owner_name || "unknown owner"} · ${acresStr} acres`);

    flyToActiveParcel(false);

    if (window.PS_onParcelSelect) window.PS_onParcelSelect(window.PS_STATE.parcel);
  }

  // ── selectParcel ───────────────────────────────────────────────────────
  function selectParcel(props, geometry, shiftKey) {
    const pin = props.pin || props.PIN;

    if (shiftKey) {
      if (selectedPins.includes(pin)) {
        // Deselect
        const wasActive = (activeInfoPin === pin);
        const prevIdx   = activeInfoIndex;
        removeFromSelection(pin);
        updateSelectionBadge();

        if (selectedPins.length === 0) {
          setActiveInfoPin(null);
          hideInfoPanel();
          setStatusStrip(DEFAULT_STATUS);
          window.PS_STATE.parcel = null;
          return;
        }

        if (wasActive) {
          showParcelAtIndex(Math.min(prevIdx, selectedPins.length - 1));
        } else {
          activeInfoIndex = selectedPins.indexOf(activeInfoPin);
          updateInfoPanelNav();
        }
      } else {
        // Add
        addToSelection(pin, props, geometry);
        updateSelectionBadge();
        showParcelAtIndex(selectedPins.length - 1);
      }
    } else {
      // Replace entire selection
      for (const p of selectedPins) {
        if (map) map.setFeatureState({ source: "parcels", sourceLayer: SOURCE_LAYER, id: p }, { selected: false, activeInfo: false });
      }
      selectedPins = [];
      selectedFeatureMap.clear();
      activeInfoPin = null;
      activeInfoIndex = 0;

      addToSelection(pin, props, geometry);
      updateSelectionBadge();
      showParcelAtIndex(0);
    }
  }

  // ── Public APIs ────────────────────────────────────────────────────────
  window.PS_zoomToParcel = function () {
    if (!map || !activeInfoPin) return;
    const entry = selectedFeatureMap.get(activeInfoPin);
    if (!entry) return;
    map.fitBounds(computeBounds(entry.geometry), { padding: 80, duration: 600, maxZoom: 17 });
  };

  window.PS_highlightParcel = function (pin) {
    if (!map) return;
    if (selectedPins.includes(pin)) return;
    const feature = parcelIndex.find(f => (f.properties.pin || f.properties.PIN) === pin);
    if (feature) {
      addToSelection(pin, feature.properties, feature.geometry);
      updateSelectionBadge();
      showParcelAtIndex(selectedPins.length - 1);
    }
  };

  // Programmatic parcel selection by DB id: fetches the full record, replaces
  // the current selection, and zooms to the parcel. Used by omni-search and
  // the Parcel Edits workflows.
  window.PS_selectParcelById = function (id, opts) {
    if (!map || id == null) return Promise.resolve(null);
    opts = opts || {};
    return fetchParcel(id).then((feature) => {
      const pin = feature.properties.pin || feature.properties.parcel_no;
      for (const p of selectedPins) {
        map.setFeatureState({ source: "parcels", sourceLayer: SOURCE_LAYER, id: p }, { selected: false, activeInfo: false });
      }
      selectedPins = [];
      selectedFeatureMap.clear();
      activeInfoPin = null;
      activeInfoIndex = 0;

      addToSelection(pin, feature.properties, feature.geometry);
      updateSelectionBadge();
      showParcelAtIndex(0);
      // The search box opts into a cinematic arrival; other callers (MapBuddy
      // workflows, etc.) get the quick fit so they aren't slowed down.
      if (opts.cinematic) {
        window.PS_cinematicFlyTo(feature.geometry);
      } else {
        map.fitBounds(computeBounds(feature.geometry), { padding: 80, duration: 800, maxZoom: 17 });
      }
      return feature;
    });
  };

  // Cinematic arrival: tilt into 3-D, fly in, orbit a full 360° around the
  // parcel, then settle back to flat north-up. Cancels on user interaction and
  // honors reduced-motion. Used by parcel search and MapBuddy's "fly to".
  let _cineRAF = null;
  function _cancelCine() { if (_cineRAF) { cancelAnimationFrame(_cineRAF); _cineRAF = null; } }
  window.PS_cinematicFlyTo = function (geometry, zoom) {
    if (!map || !geometry) return;
    const [lng, lat] = computeCentroid(geometry);
    const center = [lng, lat];
    let z = zoom;
    if (z == null) {
      const cfb = map.cameraForBounds && map.cameraForBounds(computeBounds(geometry), { padding: 140, maxZoom: 18 });
      z = cfb ? Math.min(cfb.zoom - 0.4, 18) : 17;
    }
    let reduced = false;
    try { reduced = document.documentElement.classList.contains("pv-a11y-motion") || matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
    _cancelCine();
    if (reduced) { map.easeTo({ center, zoom: z, pitch: 0, bearing: 0, duration: 1000 }); return; }

    // Power users can disable the 360° orbit (Settings): keep a quick fly-in,
    // settle north-up and flat, skip the spin entirely.
    let orbitOn = true;
    try { if (window.PV_PREFS && window.PV_PREFS.getCinematicOrbit) orbitOn = window.PV_PREFS.getCinematicOrbit(); } catch (e) {}
    if (!orbitOn) { map.flyTo({ center, zoom: z, pitch: 0, bearing: 0, speed: 1.2, curve: 1.4, essential: true }); return; }

    const userEvents = ["mousedown", "touchstart", "wheel"];
    function cleanup() { userEvents.forEach((ev) => map.off(ev, onInteract)); }
    function onInteract() { _cancelCine(); cleanup(); }
    userEvents.forEach((ev) => map.on(ev, onInteract));

    let started = false;
    map.flyTo({ center, zoom: z, pitch: 60, bearing: 0, speed: 0.85, curve: 1.5, essential: true });
    function orbit() {
      if (started) return; started = true;
      const ORBIT_MS = 9000; let t0 = null;
      function frame(ts) {
        if (t0 === null) t0 = ts;
        const k = Math.min((ts - t0) / ORBIT_MS, 1);
        const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        map.setBearing(360 * eased);
        map.setCenter(center);
        map.setPitch(60);  // hold full tilt through the orbit (fly may not have finished tilting)
        if (k < 1) { _cineRAF = requestAnimationFrame(frame); }
        else { _cineRAF = null; cleanup(); map.easeTo({ bearing: 0, pitch: 0, duration: 2600 }); }
      }
      _cineRAF = requestAnimationFrame(frame);
    }
    map.once("moveend", orbit);
    setTimeout(orbit, 5000);  // safety if moveend never fires (e.g. already in place)
  };

  // Legacy pin-based selection (viewport index lookup) — kept for
  // MapControlAPI compatibility.
  window.PS_selectParcel = function (pin) {
    const feature = parcelIndex.find(f => (f.properties.pin || f.properties.PIN) === pin);
    if (feature && feature.properties.id != null) {
      window.PS_selectParcelById(feature.properties.id);
    }
  };

  // ── Parcel search (server-side omni-search via GET /search) ────────────
  let parcelIndex = [];
  window.PS_PARCEL_INDEX = parcelIndex;

  const searchInput   = document.getElementById("parcel-search-input");
  const searchResults = document.getElementById("parcel-search-results");
  const searchStatus  = document.getElementById("parcel-search-status");

  // ── ARIA combobox state (DIC-381) ──
  let _options = [];     // [{ el, parcelId }]
  let _activeIdx = -1;

  function setExpanded(open) { searchInput.setAttribute("aria-expanded", String(open)); }

  function setActive(idx) {
    if (_activeIdx >= 0 && _options[_activeIdx]) {
      _options[_activeIdx].el.classList.remove("active");
      _options[_activeIdx].el.setAttribute("aria-selected", "false");
    }
    _activeIdx = idx;
    if (idx >= 0 && _options[idx]) {
      const o = _options[idx].el;
      o.classList.add("active");
      o.setAttribute("aria-selected", "true");
      searchInput.setAttribute("aria-activedescendant", o.id);
      o.scrollIntoView({ block: "nearest" });
    } else {
      searchInput.removeAttribute("aria-activedescendant");
    }
  }

  function selectOption(idx) {
    const o = _options[idx];
    if (!o) return;
    // Direct focus into the parcel region once it renders (keyboard lifeline).
    _focusInfoPanelOnShow = true;
    _lastFocusBeforeInfo = searchInput;
    window.PS_selectParcelById(o.parcelId, { cinematic: true });
    hideResults();
    closeMobileSearch();
  }

  function hideResults() { searchResults.hidden = true; setExpanded(false); setActive(-1); }
  function clearResults() {
    searchResults.hidden = true; searchResults.innerHTML = "";
    _options = []; setExpanded(false); setActive(-1);
    if (searchStatus) searchStatus.textContent = "";
  }

  // Mobile search overlay helpers
  const _searchContainer = document.getElementById("parcel-search");

  // Close the overlay but KEEP the query + results, so reopening shows them
  // again (matches desktop: picking the wrong parcel, you can come back and
  // see the remaining matches without re-searching).
  function closeMobileSearch() {
    _searchContainer?.classList.remove("pv-search-open");
    searchResults.hidden = true;
    setExpanded(false);
  }
  // Full reset — clears the query and results (used by Escape / explicit cancel).
  function resetMobileSearch() {
    closeMobileSearch();
    searchInput.value = "";
    clearResults();
  }

  // Search icon button (mobile) → open overlay, re-showing any lingering results.
  // stopPropagation so this click doesn't reach the document "click-outside"
  // handler below, which would immediately hide the results we just revealed.
  document.getElementById("pv-search-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    _searchContainer.classList.add("pv-search-open");
    if (searchResults.innerHTML) searchResults.hidden = false;
    setTimeout(() => searchInput.focus(), 60);
  });

  // Close button inside overlay
  document.getElementById("pv-search-close")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeMobileSearch();
  });

  // Tap backdrop (the overlay container itself, not the input or results)
  _searchContainer?.addEventListener("click", (e) => {
    if (e.target === _searchContainer) closeMobileSearch();
  });

  let _searchTimer = null;
  let _searchController = null;

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim();
    if (q.length < 2) { clearResults(); return; }
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => runSearch(q), 250);
  });

  function runSearch(q) {
    if (_searchController) _searchController.abort();
    _searchController = new AbortController();

    fetch(API_BASE + "/search?q=" + encodeURIComponent(q) + "&limit=25",
          { signal: _searchController.signal })
      .then(r => r.json())
      .then(data => renderSearchResults(data.results || []))
      .catch(() => { /* aborted */ });
  }

  function renderSearchResults(results) {
    searchResults.innerHTML = "";
    searchResults.hidden = false;
    _options = [];
    setActive(-1);

    if (!results.length) {
      searchResults.innerHTML = '<div class="parcel-search-no-results">No matches found</div>';
      setExpanded(true);
      if (searchStatus) searchStatus.textContent = "No matches found";
      return;
    }

    const container = document.createElement("div");
    container.className = "parcel-search-page";

    results.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "parcel-search-result";
      row.id = "psr-opt-" + i;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.innerHTML =
        `<div class="parcel-search-result-pin">${r.pin}${r.municipality ? " &middot; " + r.municipality : ""}</div>` +
        `<div class="parcel-search-result-owner">${r.owner_name || "—"}</div>` +
        (r.address ? `<div class="parcel-search-result-address">${r.address}</div>` : "");
      const idx = i;
      row.addEventListener("click", () => selectOption(idx));
      row.addEventListener("mousemove", () => { if (_activeIdx !== idx) setActive(idx); });
      container.appendChild(row);
      _options.push({ el: row, parcelId: r.id });
    });

    searchResults.appendChild(container);
    setExpanded(true);
    if (searchStatus) {
      searchStatus.textContent = results.length + (results.length === 1 ? " result" : " results") + " found, use up and down arrow keys to navigate";
    }
  }

  searchInput.addEventListener("focus", () => {
    if (searchResults.innerHTML) { searchResults.hidden = false; if (_options.length) setExpanded(true); }
  });

  searchInput.addEventListener("keydown", (e) => {
    const open = !searchResults.hidden && _options.length > 0;
    switch (e.key) {
      case "ArrowDown":
        if (open) { e.preventDefault(); setActive((_activeIdx + 1) % _options.length); }
        break;
      case "ArrowUp":
        if (open) { e.preventDefault(); setActive((_activeIdx - 1 + _options.length) % _options.length); }
        break;
      case "Home":
        if (open) { e.preventDefault(); setActive(0); }
        break;
      case "End":
        if (open) { e.preventDefault(); setActive(_options.length - 1); }
        break;
      case "Enter":
        if (open && _activeIdx >= 0) { e.preventDefault(); selectOption(_activeIdx); }
        break;
      case "Escape":
        if (!searchResults.hidden) { e.preventDefault(); hideResults(); }
        else { resetMobileSearch(); }
        break;
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#parcel-search")) hideResults();
  });

  // Escape clears the parcel selection (and lifts the focus/dim spotlight) when
  // one is active — a universal "deselect" the map was missing. Ignored while
  // typing in a field so it doesn't fight input/search Escape handling.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !selectedPins.length) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (searchResults && !searchResults.hidden) return;   // search owns Escape first
    clearSelectionAll();
  });

  // ── Map Control Panel ──────────────────────────────────────────────────
  function initMapControlPanel() {
    const panel = document.getElementById("map-control-panel");
    if (!panel) return;

    const tabs = panel.querySelectorAll(".mcp-tab");

    const TAB_LABELS = { layers: "Layers", select: "Selection", draw: "Drawing", measure: "Measure" };
    const mcpHeaderTitle = document.getElementById("mcp-header-title");

    function switchTab(tabId) {
      const prevTab = window.PS_MAP_PANEL ? window.PS_MAP_PANEL._activeTab : null;
      tabs.forEach(t => {
        t.classList.toggle("active", t.dataset.tab === tabId);
        t.setAttribute("aria-selected", String(t.dataset.tab === tabId));
      });
      panel.querySelectorAll(".mcp-pane").forEach(p => { p.hidden = true; });
      const pane = document.getElementById("mcp-pane-" + tabId);
      if (pane) pane.hidden = false;
      if (mcpHeaderTitle) mcpHeaderTitle.textContent = TAB_LABELS[tabId] || tabId;
      if (window.PS_MAP_PANEL) window.PS_MAP_PANEL._activeTab = tabId;

      // Drawing tools tab lifecycle hooks
      if (window.PS_DRAWING_TOOLS) {
        if (tabId === "draw") {
          window.PS_DRAWING_TOOLS.onDrawTabActivated();
        } else if (prevTab === "draw") {
          window.PS_DRAWING_TOOLS.onDrawTabDeactivated();
        }
      }
      // Measurement tab lifecycle hooks
      if (window.PS_MEASURE_TOOL) {
        if (tabId === "measure") {
          window.PS_MEASURE_TOOL.onMeasureTabActivated();
        } else if (prevTab === "measure") {
          window.PS_MEASURE_TOOL.onMeasureTabDeactivated();
        }
      }
    }

    tabs.forEach(tab => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));

    // ── Progressive disclosure: basic default + Advanced Tools (DIC-402) ──
    // Layers is basic; Select/Draw/Measure are advanced (marked data-advanced,
    // overridable per viewer via COUNTY.tools.advanced). Advanced tabs are hidden
    // until the user opts in via the tab-strip toggle; the choice persists.
    (function () {
      const advToggle = document.getElementById("mcp-advanced-toggle");
      const advCfg = (window.COUNTY && COUNTY.tools && Array.isArray(COUNTY.tools.advanced))
        ? COUNTY.tools.advanced : null;
      if (advCfg) {
        tabs.forEach(t => t.toggleAttribute("data-advanced", advCfg.indexOf(t.dataset.tab) !== -1));
      }
      function isAdvancedTab(id) {
        const t = panel.querySelector('.mcp-tab[data-tab="' + id + '"]');
        return !!(t && t.hasAttribute("data-advanced"));
      }
      function setAdvanced(on) {
        panel.classList.toggle("mcp-show-advanced", on);
        if (advToggle) {
          advToggle.setAttribute("aria-pressed", String(on));
          advToggle.title = on ? "Hide advanced tools" : "Advanced tools";
        }
        try { localStorage.setItem("pv-advanced-tools", on ? "1" : "0"); } catch (e) {}
        // If advanced tools were just hidden while one was active, fall back to Layers.
        if (!on) {
          const active = window.PS_MAP_PANEL ? window.PS_MAP_PANEL._activeTab : "layers";
          if (isAdvancedTab(active)) switchTab("layers");
        }
      }
      let startOn = false;
      try { startOn = localStorage.getItem("pv-advanced-tools") === "1"; } catch (e) {}
      setAdvanced(startOn);
      if (advToggle) advToggle.addEventListener("click", () =>
        setAdvanced(advToggle.getAttribute("aria-pressed") !== "true"));
      if (window.PS_MAP_PANEL) window.PS_MAP_PANEL.setAdvancedTools = setAdvanced;  // programmatic (MapBuddy)
    })();

    // ── Header drag (same pattern as parcel info panel) ──
    const mcpHeader = document.getElementById("mcp-header");
    const mcpHeaderClose = document.getElementById("mcp-header-close");

    const mcpReopenTab = document.getElementById("mcp-reopen-tab");

    if (mcpHeaderClose) {
      mcpHeaderClose.addEventListener("click", () => {
        panel.hidden = true;
        if (mcpReopenTab) mcpReopenTab.hidden = false;
        if (window.PV_MOBILE_TABS) window.PV_MOBILE_TABS.refresh();
      });
    }

    if (mcpReopenTab) {
      mcpReopenTab.addEventListener("click", () => {
        // Clear any inline drag-position so the panel resets to CSS default
        // (right:12px bottom:12px inside #panel-map). Without this, a prior
        // drag position can place the panel outside the map area when the map
        // is narrower than it was when the drag happened (e.g. Map Buddy open).
        panel.style.left   = '';
        panel.style.top    = '';
        panel.style.right  = '';
        panel.style.bottom = '';
        panel.hidden = false;
        mcpReopenTab.hidden = true;
      });
    }

    if (mcpHeader) {
      let dragging = false, startX, startY, startLeft, startTop;
      mcpHeader.addEventListener("pointerdown", (e) => {
        if (e.target === mcpHeaderClose) return;
        dragging = true;
        mcpHeader.setPointerCapture(e.pointerId);
        const rect = panel.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        startLeft = rect.left; startTop = rect.top;
        panel.style.bottom = "auto";
        panel.style.right  = "auto";
        panel.style.left   = startLeft + "px";
        panel.style.top    = startTop  + "px";
      });
      mcpHeader.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const par = panel.parentElement.getBoundingClientRect();
        panel.style.left = Math.max(0, Math.min(par.width  - panel.offsetWidth,  startLeft - par.left + e.clientX - startX)) + "px";
        panel.style.top  = Math.max(0, Math.min(par.height - panel.offsetHeight, startTop  - par.top  + e.clientY - startY)) + "px";
      });
      mcpHeader.addEventListener("pointerup",     () => { dragging = false; });
      mcpHeader.addEventListener("pointercancel", () => { dragging = false; });
    }

    window.PS_MAP_PANEL = {
      _activeTab: "layers",
      setTab:  function (tabId) { switchTab(tabId); },
      getTab:  function () { return this._activeTab; },
      layers: {
        aerial: false, zoning: true,
        setAerial: function (v) {
          const cb = document.getElementById("toggle-aerial");
          if (cb) { cb.checked = !!v; cb.dispatchEvent(new Event("change")); this.aerial = !!v; }
        },
        setZoning: function (v) {
          const cb = document.getElementById("toggle-zoning");
          if (cb) { cb.checked = !!v; cb.dispatchEvent(new Event("change")); this.zoning = !!v; }
        },
        getState: function () { return { aerial: this.aerial, zoning: this.zoning }; },
      },
      selection: {
        getSelected: function () { return [...selectedPins]; },
        getEntries:  function () {
          return selectedPins.map(pin => {
            const e = selectedFeatureMap.get(pin);
            return { pin, props: e ? e.props : {}, geometry: e ? e.geometry : null };
          });
        },
        clearAll:    function () { clearSelectionAll(); },
      },
    };
  }

  // ── CSV download ───────────────────────────────────────────────────────
  function downloadSelectionCSV() {
    if (selectedPins.length === 0) return;

    // Gather all field names from selected features (union of keys)
    const fieldSet = new Set();
    for (const entry of selectedFeatureMap.values()) {
      for (const k of Object.keys(entry.props)) fieldSet.add(k);
    }
    const fields = [...fieldSet];

    const cell = (v) => {
      if (v == null) return "";
      const s = String(v);
      return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const rows = [fields.map(cell).join(",")];
    for (const pin of selectedPins) {
      const entry = selectedFeatureMap.get(pin);
      if (!entry) continue;
      rows.push(fields.map(f => cell(entry.props[f])).join(","));
    }

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), { href: url, download: `parcels_${selectedPins.length}_selected.csv` });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Selection tools ────────────────────────────────────────────────────
  function initSelectionTools() {
    // activeTool lives at IIFE scope so the map click handler can read it

    function setActiveTool(tool) {
      if (activeTool === tool) tool = null; // toggle off

      // Clean up buffer state when leaving buffer mode
      if (activeTool === "buffer" && tool !== "buffer") clearBufferState();

      activeTool = tool;

      document.getElementById("tool-box-select")?.classList.toggle("active", tool === "box");
      document.getElementById("tool-lasso")?.classList.toggle("active", tool === "lasso");
      document.getElementById("tool-filter")?.classList.toggle("active", tool === "filter");
      document.getElementById("tool-buffer")?.classList.toggle("active", tool === "buffer");

      const filterPanel = document.getElementById("filter-panel");
      if (filterPanel) filterPanel.hidden = tool !== "filter";

      const bufferPanel = document.getElementById("buffer-panel");
      if (bufferPanel) bufferPanel.hidden = tool !== "buffer";

      const lassoCanvas = document.getElementById("lasso-canvas");
      const boxOverlay  = document.getElementById("box-select-overlay");

      if (lassoCanvas) {
        lassoCanvas.style.pointerEvents = tool === "lasso" ? "all" : "none";
        if (tool !== "lasso") {
          const ctx = lassoCanvas.getContext("2d");
          ctx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
        }
      }
      if (boxOverlay) {
        // display:none blocks pointer-events regardless of the property, so set both
        boxOverlay.style.display       = tool === "box" ? "block" : "none";
        boxOverlay.style.pointerEvents = tool === "box" ? "all"   : "none";
      }

      const toolActiveBar = document.getElementById("tool-active-bar");
      if (toolActiveBar) {
        toolActiveBar.hidden = (tool !== "box" && tool !== "lasso");
        const label = toolActiveBar.querySelector(".tool-active-label");
        if (label) label.textContent = tool === "box" ? "Box Select active" : tool === "lasso" ? "Lasso active" : "";
      }

      if (map) {
        if (tool === "box" || tool === "lasso") {
          map.dragPan.disable();
          map.getCanvas().style.cursor = "crosshair";
        } else if (tool === "buffer") {
          map.getCanvas().style.cursor = "crosshair";
        } else {
          map.dragPan.enable();
          map.getCanvas().style.cursor = "";
        }
      }
    }

    document.getElementById("tool-box-select")?.addEventListener("click", () => setActiveTool("box"));
    document.getElementById("tool-lasso")?.addEventListener("click",      () => setActiveTool("lasso"));
    document.getElementById("tool-filter")?.addEventListener("click",     () => setActiveTool("filter"));
    document.getElementById("tool-buffer")?.addEventListener("click",     () => setActiveTool("buffer"));
    document.getElementById("exit-tool-btn")?.addEventListener("click",   () => setActiveTool(null));
    document.getElementById("clear-selection-btn")?.addEventListener("click", clearSelectionAll);
    document.getElementById("download-csv-btn")?.addEventListener("click", downloadSelectionCSV);

    // ── Buffer event handlers ────────────────────────────────────────────
    document.getElementById("buffer-cancel-btn")?.addEventListener("click", () => setActiveTool(null));

    document.getElementById("buffer-apply-btn")?.addEventListener("click", () => {
      if (!bufferSeedGeom) return;
      const dist  = parseFloat(document.getElementById("buffer-distance")?.value);
      const units = document.getElementById("buffer-units")?.value || "feet";
      if (!dist || dist <= 0) return;
      const includeSeed = document.getElementById("buffer-include-seed")?.checked ?? true;
      const bufferPoly  = computeBufferGeometry(bufferSeedGeom, dist, units);
      if (!bufferPoly) return;

      const firstIdx = selectedPins.length;
      let added = 0;
      for (const f of findParcelsInBuffer(bufferPoly)) {
        const pin = f.properties.pin || f.properties.PIN;
        if (!includeSeed && pin === bufferSeedPin) continue;
        if (addToSelection(pin, f.properties, f.geometry)) added++;
      }
      clearBufferState();
      updateSelectionBadge();
      if (added > 0) showParcelAtIndex(firstIdx);
      setActiveTool(null);
    });

    document.getElementById("buffer-remove-btn")?.addEventListener("click", () => {
      if (!bufferSeedGeom) return;
      const dist  = parseFloat(document.getElementById("buffer-distance")?.value);
      const units = document.getElementById("buffer-units")?.value || "feet";
      if (!dist || dist <= 0) return;
      const includeSeed = document.getElementById("buffer-include-seed")?.checked ?? true;
      const bufferPoly  = computeBufferGeometry(bufferSeedGeom, dist, units);
      if (!bufferPoly) return;

      let removed = 0;
      for (const f of findParcelsInBuffer(bufferPoly)) {
        const pin = f.properties.pin || f.properties.PIN;
        if (!includeSeed && pin === bufferSeedPin) continue;
        if (removeFromSelection(pin)) removed++;
      }
      if (removed > 0) {
        updateSelectionBadge();
        if (selectedPins.length === 0) {
          setActiveInfoPin(null);
          hideInfoPanel();
          setStatusStrip(DEFAULT_STATUS);
          window.PS_STATE.parcel = null;
        } else if (!selectedPins.includes(activeInfoPin)) {
          showParcelAtIndex(0);
        } else {
          activeInfoIndex = selectedPins.indexOf(activeInfoPin);
          updateInfoPanelNav();
        }
      }
      clearBufferState();
      setActiveTool(null);
    });

    document.getElementById("buffer-distance")?.addEventListener("input",  scheduleBufferPreview);
    document.getElementById("buffer-units")?.addEventListener("change",    scheduleBufferPreview);
    document.getElementById("buffer-include-seed")?.addEventListener("change", scheduleBufferPreview);
    document.getElementById("buffer-live-preview")?.addEventListener("change", () => {
      const live = document.getElementById("buffer-live-preview");
      if (live?.checked) scheduleBufferPreview(); else clearBufferPreviewOnly();
    });

    // Escape key cancels active spatial tool
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && (activeTool === "box" || activeTool === "lasso" || activeTool === "buffer")) {
        setActiveTool(null);
      }
    });

    // Forward scroll wheel from spatial tool overlays so map zoom still works
    for (const elId of ["lasso-canvas", "box-select-overlay"]) {
      const el = document.getElementById(elId);
      if (!el) continue;
      el.addEventListener("wheel", (e) => {
        const container = map && map.getContainer();
        if (container) container.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true, cancelable: true, view: window,
          deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ,
          deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY,
          ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey,
        }));
        e.preventDefault();
      }, { passive: false });
    }

    // ── Box Select ─────────────────────────────────────────────────────
    const boxOverlay = document.getElementById("box-select-overlay");
    if (boxOverlay) {
      let boxStart = null;
      let boxRect  = null;

      function mapPoint(e) {
        const r = document.getElementById("map").getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      }

      boxOverlay.addEventListener("pointerdown", (e) => {
        if (activeTool !== "box") return;
        e.preventDefault();
        boxOverlay.setPointerCapture(e.pointerId);
        boxStart = mapPoint(e);
        boxRect = document.createElement("div");
        boxRect.className = "box-select-rect";
        boxOverlay.appendChild(boxRect);
        boxOverlay.style.display = "block";
      });

      boxOverlay.addEventListener("pointermove", (e) => {
        if (!boxStart || !boxRect) return;
        const cur = mapPoint(e);
        boxRect.style.cssText =
          `left:${Math.min(boxStart.x, cur.x)}px;` +
          `top:${Math.min(boxStart.y, cur.y)}px;` +
          `width:${Math.abs(cur.x - boxStart.x)}px;` +
          `height:${Math.abs(cur.y - boxStart.y)}px;`;
      });

      boxOverlay.addEventListener("pointerup", (e) => {
        if (!boxStart) return;
        const cur = mapPoint(e);

        const sw = map.unproject([Math.min(boxStart.x, cur.x), Math.max(boxStart.y, cur.y)]);
        const ne = map.unproject([Math.max(boxStart.x, cur.x), Math.min(boxStart.y, cur.y)]);
        const [minLng, maxLng] = [Math.min(sw.lng, ne.lng), Math.max(sw.lng, ne.lng)];
        const [minLat, maxLat] = [Math.min(sw.lat, ne.lat), Math.max(sw.lat, ne.lat)];

        let added = 0;
        const firstIdx = selectedPins.length;
        for (const f of parcelIndex) {
          const [lng, lat] = computeCentroid(f.geometry);
          if (lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat) {
            if (addToSelection(f.properties.pin || f.properties.PIN, f.properties, f.geometry)) added++;
          }
        }
        updateSelectionBadge();
        if (added > 0) showParcelAtIndex(firstIdx);

        if (boxRect) { boxRect.remove(); boxRect = null; }
        boxStart = null;
        boxOverlay.style.display = "none";
      });
    }

    // ── Lasso Select ───────────────────────────────────────────────────
    const lassoCanvas = document.getElementById("lasso-canvas");
    if (lassoCanvas) {
      let lassoPoints  = [];
      let lassoDragging = false;
      let lassoCtx     = null;

      function resizeLasso() {
        const r = document.getElementById("map").getBoundingClientRect();
        lassoCanvas.width  = r.width;
        lassoCanvas.height = r.height;
      }

      lassoCanvas.addEventListener("pointerdown", (e) => {
        if (activeTool !== "lasso") return;
        e.preventDefault();
        lassoCanvas.setPointerCapture(e.pointerId);
        resizeLasso();
        lassoCtx = lassoCanvas.getContext("2d");
        lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
        const r = document.getElementById("map").getBoundingClientRect();
        lassoPoints = [{ x: e.clientX - r.left, y: e.clientY - r.top }];
        lassoDragging = true;
      });

      lassoCanvas.addEventListener("pointermove", (e) => {
        if (!lassoDragging || !lassoCtx) return;
        const r  = document.getElementById("map").getBoundingClientRect();
        lassoPoints.push({ x: e.clientX - r.left, y: e.clientY - r.top });

        lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
        lassoCtx.beginPath();
        lassoCtx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
        for (const pt of lassoPoints) lassoCtx.lineTo(pt.x, pt.y);
        lassoCtx.closePath();
        lassoCtx.fillStyle   = "rgba(37,99,235,0.08)";
        lassoCtx.strokeStyle = "#1d4ed8";
        lassoCtx.lineWidth   = 1.5;
        lassoCtx.setLineDash([4, 3]);
        lassoCtx.fill();
        lassoCtx.stroke();
      });

      lassoCanvas.addEventListener("pointerup", () => {
        lassoDragging = false;
        if (lassoPoints.length < 3) { lassoPoints = []; return; }

        // Convert pixel coords to lngLat and build a closed ring
        const ring = lassoPoints.map(pt => {
          const ll = map.unproject([pt.x, pt.y]);
          return [ll.lng, ll.lat];
        });
        ring.push(ring[0]);

        let added = 0;
        const firstIdx = selectedPins.length;

        if (typeof turf !== "undefined") {
          try {
            const polygon = turf.polygon([ring]);
            for (const f of parcelIndex) {
              const [lng, lat] = computeCentroid(f.geometry);
              if (turf.booleanPointInPolygon(turf.point([lng, lat]), polygon)) {
                if (addToSelection(f.properties.pin || f.properties.PIN, f.properties, f.geometry)) added++;
              }
            }
          } catch (_) {}
        }

        updateSelectionBadge();
        if (added > 0) showParcelAtIndex(firstIdx);

        if (lassoCtx) lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
        lassoPoints = [];
      });
    }

    // ── Filter Select ──────────────────────────────────────────────────
    const filterField = document.getElementById("filter-field");
    const filterOp    = document.getElementById("filter-op");
    const filterValue = document.getElementById("filter-value");
    const matchCount  = document.getElementById("filter-match-count");

    // Populate field list once parcelIndex loads
    const fieldPoll = setInterval(() => {
      if (!parcelIndex.length || !filterField) return;
      clearInterval(fieldPoll);
      const existing = new Set(Array.from(filterField.options).map(o => o.value));
      for (const key of Object.keys(parcelIndex[0].properties)) {
        if (!existing.has(key)) {
          const opt = document.createElement("option");
          opt.value = key;
          opt.textContent = key.replace(/_/g, " ");
          filterField.appendChild(opt);
        }
      }
    }, 400);

    function runFilter() {
      if (!filterField || !filterOp || !filterValue) return [];
      const field = filterField.value;
      const op    = filterOp.value;
      const val   = filterValue.value.trim().toLowerCase();
      if (!field || !val) return [];

      return parcelIndex.filter(f => {
        const raw = f.properties[field];
        if (raw == null) return false;
        const v  = String(raw).toLowerCase();
        const n  = parseFloat(raw);
        const qn = parseFloat(val);
        switch (op) {
          case "eq":       return v === val;
          case "contains": return v.includes(val);
          case "gt":       return !isNaN(n) && !isNaN(qn) && n > qn;
          case "lt":       return !isNaN(n) && !isNaN(qn) && n < qn;
          default:         return false;
        }
      });
    }

    function refreshMatchCount() {
      if (!matchCount) return;
      if (!filterField?.value || !filterValue?.value.trim()) { matchCount.textContent = ""; return; }
      const m = runFilter();
      matchCount.textContent = `${m.length} parcel${m.length !== 1 ? "s" : ""} match`;
    }

    filterField?.addEventListener("change", refreshMatchCount);
    filterOp?.addEventListener("change",    refreshMatchCount);
    filterValue?.addEventListener("input",  refreshMatchCount);

    document.getElementById("filter-add-btn")?.addEventListener("click", () => {
      const matches = runFilter();
      const firstIdx = selectedPins.length;
      let added = 0;
      for (const f of matches) {
        if (addToSelection(f.properties.pin || f.properties.PIN, f.properties, f.geometry)) added++;
      }
      updateSelectionBadge();
      if (added > 0) showParcelAtIndex(firstIdx);
      if (matchCount) matchCount.textContent = `Added ${added} parcel${added !== 1 ? "s" : ""}`;
    });

    document.getElementById("filter-replace-btn")?.addEventListener("click", () => {
      const matches = runFilter();
      let removed = 0;
      for (const f of matches) {
        const pin = f.properties.pin || f.properties.PIN;
        if (selectedPins.includes(pin)) {
          removeFromSelection(pin);
          removed++;
        }
      }
      if (removed > 0) {
        updateSelectionBadge();
        if (selectedPins.length === 0) {
          setActiveInfoPin(null);
          hideInfoPanel();
          setStatusStrip(DEFAULT_STATUS);
          window.PS_STATE.parcel = null;
        } else {
          // keep activeInfoPin if it survived; otherwise reset to first
          if (!selectedPins.includes(activeInfoPin)) {
            showParcelAtIndex(0);
          } else {
            activeInfoIndex = selectedPins.indexOf(activeInfoPin);
            updateInfoPanelNav();
          }
        }
      }
      if (matchCount) matchCount.textContent = removed > 0 ? `Removed ${removed} parcel${removed !== 1 ? "s" : ""}` : "None in selection";
    });
  }

  // ── Annotation visualization layers ─────────────────────────────────────

  // Arrow bearing helper (geographic bearing, 0=north, CW from north)
  function _arrowBearing(ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  }

  function setupAnnotationLayers() {
    const before = "parcels-labels";

    // ── Arrow SDF image (upward-pointing triangle; SDF → data-driven icon-color) ─
    if (!map.hasImage("ps-arrow")) {
      (function () {
        var sz  = 14;
        var cv  = document.createElement("canvas");
        cv.width = sz; cv.height = sz;
        var ctx = cv.getContext("2d");
        ctx.fillStyle = "white";
        ctx.beginPath();
        ctx.moveTo(sz / 2, 0);   // tip  (top-center)
        ctx.lineTo(0,      sz);  // base left
        ctx.lineTo(sz,     sz);  // base right
        ctx.closePath();
        ctx.fill();
        var d = ctx.getImageData(0, 0, sz, sz);
        map.addImage("ps-arrow", { width: sz, height: sz, data: d.data }, { sdf: true });
      }());
    }

    // Sources
    if (!map.getSource("annotation-source")) {
      map.addSource("annotation-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        generateId: false,  // IDs are managed by AnnotationStore
      });
    }
    if (!map.getSource("snap-indicator-source")) {
      map.addSource("snap-indicator-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    // Arrow point sources (computed from arrowEnd/arrowStart style flags)
    if (!map.getSource("annotation-arrow-end-source")) {
      map.addSource("annotation-arrow-end-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!map.getSource("annotation-arrow-start-source")) {
      map.addSource("annotation-arrow-start-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    // Selection overlay sources
    if (!map.getSource("select-overlay-source")) {
      map.addSource("select-overlay-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!map.getSource("select-handles-source")) {
      map.addSource("select-handles-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    // Polygon fill
    if (!map.getLayer("annotation-fill")) {
      map.addLayer({
        id:     "annotation-fill",
        type:   "fill",
        source: "annotation-source",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "fill-color":   ["coalesce", ["get", "fillColor",   ["get", "style"]], "#3b82f6"],
          "fill-opacity": ["coalesce", ["get", "fillOpacity", ["get", "style"]], 0.18],
        },
      }, before);
    }

    // Line / polygon outline
    if (!map.getLayer("annotation-line")) {
      map.addLayer({
        id:     "annotation-line",
        type:   "line",
        source: "annotation-source",
        filter: ["in", ["geometry-type"], ["literal", ["LineString", "Polygon"]]],
        paint: {
          // coalesce guards against null when nested-get expressions are evaluated
          "line-color": ["coalesce", ["get", "strokeColor", ["get", "style"]], "#1d4ed8"],
          "line-width": ["coalesce", ["get", "strokeWidth", ["get", "style"]], 2],
          // Note: data-driven line-dasharray can silently prevent the layer from
          // rendering in some MapLibre v4 builds.  Dash style is applied at
          // draw-time by the style picker in Phase 3 via a separate layer or a
          // static paint update.  Keep this solid for now.
        },
      }, before);
    }

    // Point circles
    if (!map.getLayer("annotation-circle")) {
      map.addLayer({
        id:     "annotation-circle",
        type:   "circle",
        source: "annotation-source",
        filter: ["==", ["get", "featureType"], "point"],
        paint: {
          "circle-color":        ["coalesce", ["get", "fillColor",   ["get", "style"]], "#3b82f6"],
          "circle-radius":       5,
          "circle-stroke-color": ["coalesce", ["get", "strokeColor", ["get", "style"]], "#1d4ed8"],
          "circle-stroke-width": 2,
        },
      }, before);
    }

    // Text labels
    if (!map.getLayer("annotation-labels")) {
      map.addLayer({
        id:     "annotation-labels",
        type:   "symbol",
        source: "annotation-source",
        filter: ["!=", ["get", "label"], null],
        layout: {
          "text-field":              ["coalesce", ["get", "label"], ""],
          "text-size":               ["coalesce", ["get", "fontSize", ["get", "style"]], 12],
          "text-allow-overlap":      true,
          "text-ignore-placement":   true,
          // labelRotation is stored inside the style object (annotation-store strips top-level custom props)
          "text-rotate":             ["coalesce", ["get", "labelRotation", ["get", "style"]], 0],
          "text-rotation-alignment": "map",
        },
        paint: {
          "text-color":      ["coalesce", ["get", "fontColor", ["get", "style"]], "#1f2937"],
          "text-halo-color": "#ffffff",
          "text-halo-width": 2,
        },
      }, before);
    }

    // ── Arrow symbol layers ─────────────────────────────────────────────
    // Both use a pre-computed "bearing" property placed at the endpoint.
    // icon-rotation-alignment:"map" keeps the arrow geographically oriented.
    const arrowLayout = {
      "icon-image":              "ps-arrow",
      "icon-size":               0.85,
      "icon-rotate":             ["get", "bearing"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap":      true,
      "icon-ignore-placement":   true,
    };
    const arrowPaint = {
      "icon-color":   ["coalesce", ["get", "strokeColor", ["get", "style"]], "#1d4ed8"],
      "icon-opacity": 1,
    };
    if (!map.getLayer("annotation-arrow-end")) {
      map.addLayer({ id: "annotation-arrow-end",   type: "symbol",
                     source: "annotation-arrow-end-source",   layout: arrowLayout, paint: arrowPaint });
    }
    if (!map.getLayer("annotation-arrow-start")) {
      map.addLayer({ id: "annotation-arrow-start", type: "symbol",
                     source: "annotation-arrow-start-source", layout: arrowLayout, paint: arrowPaint });
    }

    // ── Selection overlay layers (rendered above annotations) ───────────
    // Fill (polygons only)
    if (!map.getLayer("select-fill")) {
      map.addLayer({
        id:     "select-fill",
        type:   "fill",
        source: "select-overlay-source",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint:  { "fill-color": "#00cfff", "fill-opacity": 0.10 },
      });
    }
    // Outline (lines + polygon outlines)
    if (!map.getLayer("select-outline")) {
      map.addLayer({
        id:     "select-outline",
        type:   "line",
        source: "select-overlay-source",
        paint:  { "line-color": "#00cfff", "line-width": 2, "line-dasharray": [4, 3] },
      });
    }
    // Point highlight ring
    if (!map.getLayer("select-point-highlight")) {
      map.addLayer({
        id:     "select-point-highlight",
        type:   "circle",
        source: "select-overlay-source",
        filter: ["==", ["geometry-type"], "Point"],
        paint:  {
          "circle-radius":       9,
          "circle-color":        "transparent",
          "circle-stroke-color": "#00cfff",
          "circle-stroke-width": 2.5,
        },
      });
    }
    // Rotate handle (small circle above bbox)
    if (!map.getLayer("select-rotate-handle")) {
      map.addLayer({
        id:     "select-rotate-handle",
        type:   "circle",
        source: "select-handles-source",
        filter: ["==", ["get", "handleType"], "rotate"],
        paint:  {
          "circle-radius":       7,
          "circle-color":        "#ffffff",
          "circle-stroke-color": "#00cfff",
          "circle-stroke-width": 2,
        },
      });
    }

    // Snap indicator (rendered on top of everything)
    if (!map.getLayer("snap-indicator")) {
      map.addLayer({
        id:     "snap-indicator",
        type:   "circle",
        source: "snap-indicator-source",
        paint: {
          "circle-radius":       8,
          "circle-color":        "transparent",
          "circle-stroke-color": "#00bfff",
          "circle-stroke-width": 2,
        },
      }); // no 'before' — rendered above all parcel layers
    }

    // ── Draw preview source (in-progress geometry while drawing) ─────────
    if (!map.getSource("draw-preview-source")) {
      map.addSource("draw-preview-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    // Preview polygon fill
    if (!map.getLayer("draw-preview-fill")) {
      map.addLayer({
        id:     "draw-preview-fill",
        type:   "fill",
        source: "draw-preview-source",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "fill-color":   ["coalesce", ["get", "fillColor",   ["get", "style"]], "#3b82f6"],
          "fill-opacity": ["coalesce", ["get", "fillOpacity", ["get", "style"]], 0.15],
        },
      }, before);
    }
    // Preview line (no dasharray expression — fixed visual dash for in-progress distinction)
    if (!map.getLayer("draw-preview-line")) {
      map.addLayer({
        id:     "draw-preview-line",
        type:   "line",
        source: "draw-preview-source",
        paint: {
          "line-color":   ["coalesce", ["get", "strokeColor", ["get", "style"]], "#1d4ed8"],
          "line-width":   ["coalesce", ["get", "strokeWidth", ["get", "style"]], 2],
          "line-opacity": 0.8,
        },
      }); // rendered above parcel layers, below snap-indicator
    }

    // ── Wire annotation store → MapLibre sources ─────────────────────────
    if (window.PS_ANNOTATION_STORE) {
      window.PS_ANNOTATION_STORE.subscribe(function () {
        const visible = window.PS_ANNOTATION_STORE.getVisibleAnnotations();

        // Inject top-level id into properties._id so queryRenderedFeatures
        // can reliably retrieve it (MapLibre may not expose feature.id for GeoJSON sources).
        const features = visible.features.map(function (f) {
          return Object.assign({}, f, {
            properties: Object.assign({}, f.properties, { _id: f.id }),
          });
        });

        const annotSrc = map.getSource("annotation-source");
        if (annotSrc) annotSrc.setData({ type: "FeatureCollection", features: features });

        // Build arrow endpoint point-features from arrowEnd / arrowStart flags.
        const endPts   = [];
        const startPts = [];
        features.forEach(function (f) {
          if (!f.geometry || f.geometry.type !== "LineString") return;
          const coords = f.geometry.coordinates;
          if (coords.length < 2) return;
          const style = (f.properties && f.properties.style) || {};
          const baseProps = Object.assign({}, f.properties);

          if (style.arrowEnd) {
            const n = coords.length;
            endPts.push({
              type: "Feature",
              geometry: { type: "Point", coordinates: coords[n - 1] },
              properties: Object.assign({}, baseProps, {
                bearing: _arrowBearing(coords[n-2][0], coords[n-2][1], coords[n-1][0], coords[n-1][1]),
              }),
            });
          }
          if (style.arrowStart) {
            startPts.push({
              type: "Feature",
              geometry: { type: "Point", coordinates: coords[0] },
              properties: Object.assign({}, baseProps, {
                bearing: _arrowBearing(coords[1][0], coords[1][1], coords[0][0], coords[0][1]),
              }),
            });
          }
        });

        const arrowEndSrc   = map.getSource("annotation-arrow-end-source");
        const arrowStartSrc = map.getSource("annotation-arrow-start-source");
        if (arrowEndSrc)   arrowEndSrc.setData({ type: "FeatureCollection", features: endPts });
        if (arrowStartSrc) arrowStartSrc.setData({ type: "FeatureCollection", features: startPts });
      });
    }
  }

  // ── Buffer visualization layers ────────────────────────────────────────
  function setupBufferLayers() {
    if (!map.getSource("buffer-preview-source")) {
      map.addSource("buffer-preview-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    const before = "parcels-labels";
    if (!map.getLayer("buffer-preview-fill")) {
      map.addLayer({ id: "buffer-preview-fill", type: "fill", source: "buffer-preview-source",
        paint: { "fill-color": "#0ea5e9", "fill-opacity": 0.12 } }, before);
    }
    if (!map.getLayer("buffer-preview-outline")) {
      map.addLayer({ id: "buffer-preview-outline", type: "line", source: "buffer-preview-source",
        paint: { "line-color": "#0ea5e9", "line-width": 2, "line-dasharray": [4, 3] } }, before);
    }
    if (!map.getLayer("buffer-preview-parcels")) {
      map.addLayer({ id: "buffer-preview-parcels", type: "fill", source: "parcels", "source-layer": SOURCE_LAYER,
        paint: { "fill-color": "#0ea5e9",
          "fill-opacity": ["case", ["boolean", ["feature-state", "bufferPreview"], false], 0.22, 0] } }, before);
    }
    if (!map.getLayer("buffer-seed-fill")) {
      map.addLayer({ id: "buffer-seed-fill", type: "fill", source: "parcels", "source-layer": SOURCE_LAYER,
        paint: { "fill-color": "#f97316",
          "fill-opacity": ["case", ["boolean", ["feature-state", "bufferSeed"], false], 0.40, 0] } }, before);
    }
    if (!map.getLayer("buffer-seed-line")) {
      map.addLayer({ id: "buffer-seed-line", type: "line", source: "parcels", "source-layer": SOURCE_LAYER,
        paint: { "line-color": "#ea580c",
          "line-width":   ["case", ["boolean", ["feature-state", "bufferSeed"], false], 3, 0],
          "line-opacity": ["case", ["boolean", ["feature-state", "bufferSeed"], false], 1, 0] } }, before);
    }
  }

  // ── Buffer geometry — isolated for future PostGIS migration ────────────
  function computeBufferGeometry(geometry, distance, units) {
    if (typeof turf === "undefined") return null;
    try {
      return turf.buffer({ type: "Feature", geometry }, distance, { units });
    } catch (e) {
      console.warn("turf.buffer:", e);
      return null;
    }
  }

  function findParcelsInBuffer(bufferPolygon) {
    if (!bufferPolygon) return [];
    return parcelIndex.filter(f => {
      try { return turf.booleanIntersects(f, bufferPolygon); }
      catch (_) { return false; }
    });
  }

  // ── Buffer state helpers ───────────────────────────────────────────────
  function clearBufferPreviewOnly() {
    for (const pin of bufferPreviewPins) {
      if (map) map.setFeatureState({ source: "parcels", sourceLayer: SOURCE_LAYER, id: pin }, { bufferPreview: false });
    }
    bufferPreviewPins = [];
    if (map && map.getSource("buffer-preview-source")) {
      map.getSource("buffer-preview-source").setData({ type: "FeatureCollection", features: [] });
    }
    const countEl = document.getElementById("buffer-match-count");
    if (countEl) countEl.textContent = "";
  }

  function clearBufferState() {
    if (bufferSeedPin && map) {
      map.setFeatureState({ source: "parcels", sourceLayer: SOURCE_LAYER, id: bufferSeedPin }, { bufferSeed: false });
    }
    bufferSeedPin  = null;
    bufferSeedGeom = null;
    clearBufferPreviewOnly();
    const statusEl   = document.getElementById("buffer-seed-status");
    const controlsEl = document.getElementById("buffer-controls");
    if (statusEl)   { statusEl.textContent = "Click a parcel on the map to set the seed"; statusEl.classList.remove("has-seed"); }
    if (controlsEl) controlsEl.hidden = true;
  }

  function handleBufferSeedClick(feature) {
    if (bufferSeedPin && map) {
      map.setFeatureState({ source: "parcels", sourceLayer: SOURCE_LAYER, id: bufferSeedPin }, { bufferSeed: false });
    }
    bufferSeedPin  = feature.properties.pin || feature.properties.PIN;
    bufferSeedGeom = feature.geometry;
    if (map) map.setFeatureState({ source: "parcels", sourceLayer: SOURCE_LAYER, id: bufferSeedPin }, { bufferSeed: true });

    const statusEl   = document.getElementById("buffer-seed-status");
    const controlsEl = document.getElementById("buffer-controls");
    if (statusEl)   { statusEl.textContent = `Seed: ${bufferSeedPin}`; statusEl.classList.add("has-seed"); }
    if (controlsEl) controlsEl.hidden = false;

    scheduleBufferPreview();
  }

  // ── Buffer preview ─────────────────────────────────────────────────────
  function scheduleBufferPreview() {
    clearTimeout(bufferDebounceTimer);
    bufferDebounceTimer = setTimeout(updateBufferPreview, 300);
  }

  function updateBufferPreview() {
    if (!bufferSeedGeom) return;

    const liveEl = document.getElementById("buffer-live-preview");
    if (!liveEl?.checked) { clearBufferPreviewOnly(); return; }

    const dist  = parseFloat(document.getElementById("buffer-distance")?.value);
    const units = document.getElementById("buffer-units")?.value || "feet";
    if (!dist || dist <= 0) { clearBufferPreviewOnly(); return; }

    const bufferPoly = computeBufferGeometry(bufferSeedGeom, dist, units);
    if (!bufferPoly) { clearBufferPreviewOnly(); return; }

    if (map && map.getSource("buffer-preview-source")) {
      map.getSource("buffer-preview-source").setData({ type: "FeatureCollection", features: [bufferPoly] });
    }

    // Clear old preview states
    for (const pin of bufferPreviewPins) {
      if (map) map.setFeatureState({ source: "parcels", sourceLayer: SOURCE_LAYER, id: pin }, { bufferPreview: false });
    }
    bufferPreviewPins = [];

    // Seed gets its own highlight; skip it in the preview set
    const matches = findParcelsInBuffer(bufferPoly);
    for (const f of matches) {
      const pin = f.properties.pin || f.properties.PIN;
      if (pin === bufferSeedPin) continue;
      if (map) map.setFeatureState({ source: "parcels", sourceLayer: SOURCE_LAYER, id: pin }, { bufferPreview: true });
      bufferPreviewPins.push(pin);
    }

    const includeSeed = document.getElementById("buffer-include-seed")?.checked ?? true;
    const total = bufferPreviewPins.length + (includeSeed && bufferSeedPin ? 1 : 0);
    const countEl = document.getElementById("buffer-match-count");
    if (countEl) countEl.textContent = `${total} parcel${total !== 1 ? "s" : ""} in buffer`;
  }

  // ── Unified mobile tab bar ─────────────────────────────────────────────
  // One bar under the topbar with Parcel Info | Map Controls | Map Buddy.
  // Parcel Info and Map Controls are mutually-exclusive top dropdowns; Map
  // Buddy is an independent bottom drawer (so you can chat while viewing a
  // parcel). All panels start closed on mobile.
  function initMobileTabs() {
    const bar = document.getElementById("pv-mobile-tabbar");
    if (!bar) return;

    const tabParcel   = document.getElementById("pv-mtab-parcel");
    const tabControls = document.getElementById("pv-mtab-controls");
    const tabBuddy    = document.getElementById("pv-mtab-buddy");
    const mcpPanel    = document.getElementById("map-control-panel");
    const infoPanelEl = document.getElementById("parcel-info-panel");

    const isMobile     = () => window.innerWidth <= 640;
    const controlsOpen = () => mcpPanel && !mcpPanel.hidden;
    const parcelOpen   = () => infoPanelEl && !infoPanelEl.hidden;
    const buddyOpen    = () => !!(window.PV_MAP_BUDDY && window.PV_MAP_BUDDY.isOpen && window.PV_MAP_BUDDY.isOpen());
    const hasParcel    = () => selectedPins.length > 0;

    function openControls() {
      collapseInfoPanel();                 // mutual exclusion
      mcpPanel.style.left = mcpPanel.style.top = mcpPanel.style.right = mcpPanel.style.bottom = "";
      mcpPanel.hidden = false;
      refresh();
    }
    function closeControls() { mcpPanel.hidden = true; refresh(); }

    if (tabParcel) tabParcel.addEventListener("click", () => {
      if (parcelOpen()) collapseInfoPanel();
      else if (hasParcel()) { closeControls(); expandInfoPanel(); }
      refresh();
    });

    if (tabControls) tabControls.addEventListener("click", () => {
      if (controlsOpen()) closeControls();
      else openControls();
    });

    if (tabBuddy) tabBuddy.addEventListener("click", () => {
      if (window.PV_MAP_BUDDY && window.PV_MAP_BUDDY.toggle) window.PV_MAP_BUDDY.toggle();
      refresh();
    });

    function refresh() {
      if (tabParcel) {
        tabParcel.classList.toggle("active", parcelOpen());
        tabParcel.disabled = !hasParcel();
      }
      if (tabControls) tabControls.classList.toggle("active", controlsOpen());
      if (tabBuddy)    tabBuddy.classList.toggle("active", buddyOpen());
    }

    window.PV_MOBILE_TABS = { refresh };

    // Start with everything closed on mobile.
    if (isMobile() && mcpPanel) mcpPanel.hidden = true;
    refresh();
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────
  initTheme();
  initMap();
  initMapControlPanel();
  initSelectionTools();
  initMobileTabs();
})();
