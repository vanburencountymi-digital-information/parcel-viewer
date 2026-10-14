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
  const ctx = window.PS_CONTEXT || null;
  const API_BASE = window.API_BASE || "";
  const MARTIN_URL = (window.PS_CONFIG && window.PS_CONFIG.MARTIN_URL) || "/tiles";

  // Phase 3 (A5 source abstraction): the parcel source's IDENTITY — its MVT source-layer
  // name and id field — comes from the manifest source entry (PS_MANIFEST.sources['parcels'],
  // injected with idField:'pin' by the assembler) with the historical literals as fallback.
  // Inline read (module init runs before the manifest()/sourceCfg() helpers below; PS_MANIFEST
  // is published by pv-manifest.js BEFORE this script). The MapLibre source id stays the
  // literal "parcels" (the style.json source name — not a manifest concern). All downstream
  // feature-state / buffer-layer uses inherit SOURCE_LAYER, so they become manifest-driven
  // here without touching each call site. Additive: today the manifest carries no parcels
  // sourceLayer, so SOURCE_LAYER is "parcels" unchanged; idField resolves to "pin" from the
  // manifest (real consumption, same value).
  function _manifestSourceById(id) {
    var m = window.PS_MANIFEST;
    var ss = (m && Array.isArray(m.sources)) ? m.sources : null;
    if (!ss) return null;
    for (var i = 0; i < ss.length; i++) if (ss[i] && ss[i].id === id) return ss[i];
    return null;
  }
  const _parcelSrc = _manifestSourceById("parcels");
  const SOURCE_LAYER = (_parcelSrc && _parcelSrc.sourceLayer) || "parcels";
  const PARCEL_ID_FIELD = (_parcelSrc && _parcelSrc.idField) || "pin";
  // The §5 parcel popup section-NAME list from the manifest (D7): the manifest declares
  // which sections + order; the rich per-field config + render stay viewer-owned below.
  const PARCEL_POPUP_SECTIONS = (_parcelSrc && _parcelSrc.popup && Array.isArray(_parcelSrc.popup.sections))
    ? _parcelSrc.popup.sections.slice()
    : ["Parcel", "Owner", "Assessed Values", "Tax Description"];
  // Expose the resolved parcel-source identity (read-only) for other modules / diagnostics.
  window.PV_PARCEL_SOURCE = { id: "parcels", sourceLayer: SOURCE_LAYER, idField: PARCEL_ID_FIELD,
    popupSections: PARCEL_POPUP_SECTIONS, fromManifest: !!_parcelSrc };

  function countyConfig() {
    return (ctx && ctx.config) || window.COUNTY || {};
  }

  // A3 (DIC-568): read user prefs through the injected context (ctx.prefs === window.PV_PREFS
  // via the bridge's lazy getter), falling back to the global if the context isn't present.
  function prefs() {
    return (ctx && ctx.prefs) || window.PV_PREFS || null;
  }

  // A3 (DIC-568): the viewport parcel index via the injected context (ctx.sourceIndex ===
  // window.PS_PARCEL_INDEX). map.js still WRITES the global (the source of truth the drawing
  // stack + parcel-studio read); READS route through the context.
  function sourceIndex() {
    return (ctx && ctx.sourceIndex) || window.PS_PARCEL_INDEX || [];
  }

  // Phase 1 (manifest-driven boot): read migrated fields from the assembled theme manifest
  // (window.PS_MANIFEST, published by pv-manifest.js BEFORE this script) with a COUNTY
  // fallback. This is the read-migration pattern the rest of A3 follows — additive, so a
  // missing/invalid manifest degrades to the legacy COUNTY reads with zero behavior change.
  function manifest() {
    var m = window.PS_MANIFEST;
    return (m && typeof m === "object") ? m : null;
  }
  // Branding name: manifest.branding.name → COUNTY.name.
  function brandName() {
    var m = manifest();
    return (m && m.branding && m.branding.name) || countyConfig().name || "";
  }
  // Map camera block: manifest.map (center/zoom/extent) → COUNTY.map.
  function mapConfig() {
    var m = manifest();
    if (m && m.map && typeof m.map === "object") return m.map;
    return countyConfig().map || {};
  }

  // Stamp the county name into the topbar from the manifest (→ COUNTY fallback).
  if (brandName()) {
    document.addEventListener("DOMContentLoaded", function () {
      var el = document.querySelector(".pv-brand-county");
      if (el) el.textContent = brandName();
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
  // Set by the Selection Tools pane (a Vue island) through PS_SELECT_MAP.setTool.
  let activeTool        = null;
  let bufferSeedPin     = null;
  let bufferPreviewPins = [];

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
  // The formatters live in pv-coords.js (shared with the right-click menu; DIC-1882).
  const COORD_FORMATS = window.PV_COORD_FMT.readoutFormats;
  let _lastLngLat = null;

  function _coordFormat() {
    const f = localStorage.getItem("pv-coord-format");
    return COORD_FORMATS.indexOf(f) !== -1 ? f : "dd";
  }
  function _formatLngLat(ll) {
    return window.PV_COORD_FMT.readout(ll, _coordFormat());
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
      rerenderOpenParcel();   // the panel's "Center" row uses the same format
    });
    // Hook for a future Settings control.
    window.PV_COORDS = {
      setFormat: (f) => { if (COORD_FORMATS.indexOf(f) !== -1) { localStorage.setItem("pv-coord-format", f); _renderCoords(); rerenderOpenParcel(); } },
      getFormat: _coordFormat,
      formats: COORD_FORMATS.slice(),
    };

    // Persistent zoom readout (DIC-514): tells you the current zoom so the
    // "visible at zoom N+" layer hints make sense at a glance.
    const zEl = document.getElementById("pv-zoom");
    if (zEl) {
      const renderZoom = () => { zEl.textContent = "z" + map.getZoom().toFixed(1); };
      map.on("zoom", renderZoom);
      renderZoom();
    }
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
    if (!res.ok) throw new Error("style.json HTTP " + res.status);
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

  // Feature-state highlight delegated to the source-agnostic engine helper
  // (A4 slice 2 / DIC-569). Behavior-identical; falls back to a direct
  // setFeatureState if the engine isn't loaded, so PV can't regress.
  const _highlighter = (window.ISV_HIGHLIGHT)
    ? window.ISV_HIGHLIGHT.createFeatureHighlighter({ map: () => map, sourceId: "parcels", sourceLayer: SOURCE_LAYER })
    : null;
  function setFS(id, state) {
    if (_highlighter) _highlighter.set(id, state);
    else if (map) map.setFeatureState({ source: "parcels", sourceLayer: SOURCE_LAYER, id: id }, state);
  }

  // Info panel renders from the bus (A4 slice 3 / DIC-569): the selection code emits
  // 'active-feature-changed'; the panel subscribes HERE instead of being called inline
  // from selection. showParcelInfo's internals are unchanged — only WHO triggers it is
  // decoupled. (Falls back to a direct call at the emit site if the bus is absent.)
  if (window.PS_BUS) {
    window.PS_BUS.on("active-feature-changed", function (e) {
      const r = e && e.ref;
      if (r && r.sourceId === "parcels" && r.properties) {
        showParcelInfo(r.selectionKey || r.pin || r.id, r.properties, r.geometry);
      }
    });
  }

  // ── Selection management ───────────────────────────────────────────────
  function addToSelection(pin, props, geometry) {
    if (selectedPins.includes(pin)) return false;
    selectedPins.push(pin);
    selectedFeatureMap.set(pin, { props, geometry });
    setFS(pin, { selected: true });
    return true;
  }

  function removeFromSelection(pin) {
    const idx = selectedPins.indexOf(pin);
    if (idx === -1) return false;
    selectedPins.splice(idx, 1);
    selectedFeatureMap.delete(pin);
    setFS(pin, { selected: false, activeInfo: false });
    return true;
  }

  function announceSelectionCleared() {
    if (window.PS_SELECTION) {
      window.PS_SELECTION.clear();
      if (typeof window.PS_SELECTION.clearActive === "function") window.PS_SELECTION.clearActive();
    } else if (window.PS_BUS) {
      window.PS_BUS.emit("selection-changed", { ref: null, previous: null });
      window.PS_BUS.emit("active-feature-changed", { ref: null, previous: null });
    }
  }

  function resetSelectionStorage() {
    for (const pin of selectedPins) {
      setFS(pin, { selected: false, activeInfo: false });
    }
    selectedPins = [];
    selectedFeatureMap.clear();
    activeInfoPin = null;
    activeInfoIndex = 0;
  }

  function clearSelectionAll() {
    resetSelectionStorage();
    updateSelectionBadge();
    hideInfoPanel();
    setStatusStrip(DEFAULT_STATUS);
    window.PS_STATE.parcel = null;
    // Announce the clear on the bus (A4 slice 2) — the select-side hook isn't called
    // on deselect, so this completes the selection-changed stream for subscribers.
    announceSelectionCleared();
  }

  function setActiveInfoPin(pin) {
    if (activeInfoPin) setFS(activeInfoPin, { activeInfo: false });
    activeInfoPin = pin;
    if (pin) setFS(pin, { activeInfo: true });
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
    try { var _p = prefs(); mode = (_p && _p.getMapReactions && _p.getMapReactions()) || "subtle"; } catch (_) {}
    if (mode === "full") {
      let reduced = false;
      try { reduced = document.documentElement.classList.contains("pv-a11y-motion") || matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) {}
      if (reduced) mode = "subtle";   // a11y: reduced-motion never gets cinematics
    }
    return mode;
  }

  function updateSelectionBadge() {
    // Notify listeners (Parcel Edits pane) whenever the selection set changes
    // and the Selection Tools pane (its CSV and Clear buttons).
    document.dispatchEvent(new CustomEvent("ps:selection-changed", {
      detail: { pins: [...selectedPins] },
    }));
    if (_spotlightFn) _spotlightFn();   // re-evaluate the focus/dim spotlight
  }

  // ── Overlay pulse (DIC-515) ────────────────────────────────────────────
  // The overlay half of reactive cartography (DIC-508). When Map Buddy
  // *references* an overlay in conversation ("this parcel is in the
  // floodplain"), `PS_pulseOverlay(id)` briefly blooms that layer so the eye
  // goes there, then settles it back to its resting paint. Pairs with the
  // focus/dim spotlight (which owns the parcel half via the selection bridge).
  //
  // `id` is tolerant: an exact overlay id ('overlay-flood' / a PostGIS layer
  // id), the bare name ('flood'), or a label substring ('Flood'). It resolves
  // across BOTH overlay registries — the federal WMS rasters
  // (PS_OVERLAY_LAYERS) and the config-driven PostGIS vectors (PS_PG_LAYERS,
  // DIC-502) — and pulses whichever MapLibre layers back it.
  //
  // Honors the "Map reactions" setting + reduced-motion exactly like the
  // spotlight: Off = no-op; reduced-motion = ensure the layer is visible but
  // never flash; Subtle = one gentle pulse; Full = two stronger pulses.
  const _PULSE_SUFFIXES = ["-fill", "-line", "-circle", "-casing", "-glow"];

  function _opacityProp(type) {
    switch (type) {
      case "raster":    return "raster-opacity";
      case "fill":      return "fill-opacity";
      case "line":      return "line-opacity";
      case "circle":    return "circle-opacity";
      case "hillshade": return "hillshade-exaggeration";  // relief has no opacity
      default:          return null;
    }
  }

  // Resolve a loose overlay reference to { enable, layerIds } across both
  // registries, or null if nothing matches.
  function _resolveOverlayPulse(ref) {
    if (!window.PS_MAP || ref == null) return null;
    const want = String(ref).toLowerCase().trim();
    if (!want) return null;
    const matches = (o) => {
      const id = String(o.id).toLowerCase();
      const label = String(o.label || "").toLowerCase();
      return id === want ||
        id === "overlay-" + want ||
        id.replace(/^overlay-/, "") === want ||
        (want.length >= 3 && (id.indexOf(want) !== -1 || label.indexOf(want) !== -1));
    };
    // WMS raster / hillshade overlays — one MapLibre layer, id === overlay id.
    const wms = window.PS_OVERLAY_LAYERS;
    if (wms && wms.overlays) {
      const hit = wms.overlays.filter(matches)[0];
      if (hit) return {
        enable: () => { try { wms.setOverlay(hit.id, true); } catch (_) {} },
        layerIds: [hit.id],
      };
    }
    // PostGIS vector overlays — several MapLibre layers, id + suffix.
    const pg = window.PS_PG_LAYERS;
    if (pg && pg.overlays) {
      const ov = typeof pg.overlays === "function" ? pg.overlays() : pg.overlays;
      const hit = (ov || []).filter(matches)[0];
      if (hit) return {
        enable: () => { try { pg.setOverlay(hit.id, true); } catch (_) {} },
        layerIds: _PULSE_SUFFIXES.map((s) => hit.id + s),
      };
    }
    return null;
  }

  window.PS_pulseOverlay = function (id) {
    const map = window.PS_MAP;
    if (!map) return false;
    const mode = _effectiveReactions();          // 'off' | 'subtle' | 'full'
    if (mode === "off") return false;

    const target = _resolveOverlayPulse(id);
    if (!target) return false;

    // Bring the overlay on — can't draw the eye to a hidden layer. The lazy
    // add is synchronous when the map is ready, so the layers exist below.
    target.enable();

    let reduced = false;
    try {
      reduced = document.documentElement.classList.contains("pv-a11y-motion") ||
        matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {}
    if (reduced) return true;                     // visible, but no flashing

    const pulses = mode === "full" ? 2 : 1;
    const toward = mode === "full" ? 0.85 : 0.55; // fraction of the way to full
    const STEP = 360;                             // half-cycle (ms)

    setTimeout(function () {                       // let a freshly-added layer mount
      target.layerIds.forEach(function (lid) {
        const ly = map.getLayer(lid);
        if (!ly) return;
        const prop = _opacityProp(ly.type);
        if (!prop) return;
        let rest = map.getPaintProperty(lid, prop);
        if (typeof rest !== "number") rest = 1;
        const peak = ly.type === "hillshade"
          ? Math.min(rest * 1.6, 2)                // exaggerate relief, not opacity
          : Math.min(rest + (1 - rest) * toward, 1);
        try { map.setPaintProperty(lid, prop + "-transition", { duration: STEP }); } catch (_) {}
        let n = 0;
        (function cycle() {
          try { map.setPaintProperty(lid, prop, peak); } catch (_) {}
          setTimeout(function () {
            try { map.setPaintProperty(lid, prop, rest); } catch (_) {}
            if (++n < pulses) setTimeout(cycle, STEP);
          }, STEP);
        })();
      });
    }, 60);
    return true;
  };

  // ── Full parcel record fetch (property card / selection payload) ───────
  // Vector-tile features carry only the lightweight tile attributes and
  // tile-clipped geometry; the authoritative record comes from the API.
  const _parcelCache = new Map();   // id -> Feature

  // Every parcel API response passes through PV_ACCESS (pv-access.js), which tells the
  // visitor when a Protected county's daily detail limit has been reached (ADR 0015).
  const noteAccess = (json) => (window.PV_ACCESS ? window.PV_ACCESS.note(json) : json);
  const isWithheld = (props) => !!(window.PV_ACCESS && window.PV_ACCESS.isWithheld(props));

  async function fetchParcel(id) {
    if (_parcelCache.has(id)) return _parcelCache.get(id);
    const res = await fetch(API_BASE + "/parcel/" + id);
    if (!res.ok) throw new Error("Parcel fetch failed (" + res.status + ")");
    const feature = noteAccess(await res.json());
    // A withheld record isn't cached: once the budget resets, the full one is fetched.
    if (!isWithheld(feature.properties)) _parcelCache.set(id, feature);
    return feature;
  }

  function invalidateParcelCache() { _parcelCache.clear(); }

  // ── Viewport parcel index hydration ────────────────────────────────────
  // Feeds PS_PARCEL_INDEX (snapping engine, selection tools, labels) from
  // GET /parcels?bbox= for the current viewport. Replaces ZIP-POC's full
  // client-side parcels.geojson load.
  const PARCEL_INDEX_MIN_ZOOM = 12;
  const PARCEL_INDEX_LIMIT = 4000;     // matches the /parcels API default cap
  let _hydrateTimer = null;
  let _hydrateController = null;
  let _lastFetch = null;               // { w, s, e, n, capped } of the last padded fetch

  function scheduleParcelIndexRefresh() {
    clearTimeout(_hydrateTimer);
    _hydrateTimer = setTimeout(refreshParcelIndex, 350);
  }

  // True when the viewport is fully inside the last fetched (padded) bounds AND
  // that fetch returned everything (not truncated) — so the index already covers
  // what's on screen and we can skip the ~2 MB round-trip (DIC-528).
  function _indexCoversViewport() {
    if (!_lastFetch || _lastFetch.capped || !map) return false;
    const b = map.getBounds();
    return _lastFetch.w <= b.getWest() && _lastFetch.s <= b.getSouth() &&
           _lastFetch.e >= b.getEast() && _lastFetch.n >= b.getNorth();
  }

  // `force` (used after an edit) refetches even when the viewport looks covered.
  function refreshParcelIndex(force) {
    if (!map) return;
    if (map.getZoom() < PARCEL_INDEX_MIN_ZOOM) return;   // keep last index when zoomed out
    if (force === true) _lastFetch = null;
    if (_indexCoversViewport()) return;                  // already loaded this area

    // Fetch a padded bbox (~20% beyond the viewport) so small pans stay inside it
    // and don't trigger another fetch.
    const b = map.getBounds();
    const w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
    const padX = (e - w) * 0.2, padY = (n - s) * 0.2;
    const fw = w - padX, fs = s - padY, fe = e + padX, fn = n + padY;
    const bbox = [fw, fs, fe, fn].join(",");

    if (_hydrateController) _hydrateController.abort();
    _hydrateController = new AbortController();

    fetch(API_BASE + "/parcels?bbox=" + bbox, { signal: _hydrateController.signal })
      .then(r => r.json())
      .then(noteAccess)
      .then(data => {
        parcelIndex = (data.features || []).filter(f => f.geometry);
        window.PS_PARCEL_INDEX = parcelIndex;
        _lastFetch = { w: fw, s: fs, e: fe, n: fn, capped: parcelIndex.length >= PARCEL_INDEX_LIMIT };
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
    // Only a host with an edit backend (Parcel Studio) serves /ws; the standalone viewer
    // doesn't. Retrying every 3s forever there logged a console error every 3s for every
    // visitor. So: if the socket has never connected, try once more and give up; once it
    // has connected, keep reconnecting with a capped backoff (DIC-1873).
    let socket, everOpened = false, failures = 0;
    function open() {
      try { socket = new WebSocket(url); } catch (_) { return; }
      socket.onopen = () => { everOpened = true; failures = 0; };
      socket.onmessage = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg && msg.type === "parcels-updated") refreshParcelTiles();
      };
      socket.onclose = () => {
        failures++;
        if (!everOpened && failures >= 2) return;              // no live-update backend here
        setTimeout(open, Math.min(30000, 3000 * Math.pow(2, failures - 1)));
      };
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
    // MapLibre internals: `tileManagers` since 6.x (SourceCache became TileManager),
    // `sourceCaches` before. Not public API, so check it still exists after an upgrade.
    const caches = map.style && (map.style.tileManagers || map.style.sourceCaches);
    const sc = caches && caches["parcels"];
    if (sc) {
      sc.reload();
      map.triggerRepaint();
    }

    invalidateParcelCache();
    refreshParcelIndex(true);   // edit changed data — bypass the coverage skip
  }
  window.PS_refreshParcelTiles = refreshParcelTiles;

  // ── Hover (filter-based, unchanged) ───────────────────────────────────
  function setHoverFilter(pin) {
    if (!map || !map.getLayer("parcels-hover")) return;
    map.setFilter("parcels-hover", ["==", ["get", "pin"], pin || ""]);
  }

  // ── Theme (dark / light) ───────────────────────────────────────────────
  // Esri Canvas basemap (keyless): base + a separate label layer, light/dark variants.
  // Sources are defined in style.json (backend routers/parcels.py).
  const ESRI_CANVAS = "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/";
  const esriTiles = (svc) => [ESRI_CANVAS + svc + "/MapServer/tile/{z}/{y}/{x}"];
  const BASEMAP_TILES = {
    light: { base: esriTiles("World_Light_Gray_Base"), labels: esriTiles("World_Light_Gray_Reference") },
    dark:  { base: esriTiles("World_Dark_Gray_Base"),  labels: esriTiles("World_Dark_Gray_Reference") },
  };

  // ── Per-layer styling (DIC-460) ─────────────────────────────────────────────
  // styling.layers keys logical layers → { label, paint:{light,dark:{fill,stroke}},
  // choropleth:{…} }, so paint + choropleth scale to many layers, not just parcels.
  // Back-compat: an older manifest with top-level styling.parcels / styling.choropleth
  // is normalized into a single 'parcels' entry.
  function stylingLayers() {
    const st = countyConfig().styling || {};
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

  // Where a choropleth reads its value (DIC-527): a vector-tile attribute
  // (engine 'tile') or per-parcel assessing data pushed onto feature-state
  // (engine 'feature-state'). stateKey names the feature-state slot.
  function _choroNumInput(ch) {
    return ch.engine === "feature-state"
      ? ["to-number", ["feature-state", ch.stateKey || ch.attribute], 0]
      : ["to-number", ["get", ch.attribute], 0];
  }
  // The key a categorical ramp matches on: the raw attribute, or — with transform
  // 'classGroup' — the first character of prop_class (Michigan major class: 1xx
  // Ag, 4xx Res, …). Feature-state views read the hydrated slot instead.
  function _choroKey(ch) {
    if (ch.engine === "feature-state") return ["to-string", ["feature-state", ch.stateKey || ch.attribute]];
    const get = ["to-string", ["get", ch.attribute]];
    return ch.transform === "classGroup" ? ["slice", get, 0, 1] : get;
  }

  // Build the MapLibre fill-color expression for a choropleth config. Theme-aware
  // (DIC-506): each category/stop may carry a `colorDark`; with no dark variant it
  // falls back to its light `color`.
  function choroplethFillExpr(ch, dark) {
    const hue = (o) => (dark && o.colorDark) ? o.colorDark : o.color;
    const fallback = (dark && ch.fallbackDark) || ch.fallback || (dark ? "#2a251d" : "#d9d2c5");
    if (ch.mode === "graduated") {
      const stops = (ch.stops || []).slice().sort((a, b) => (a.min || 0) - (b.min || 0));
      const ramp = ["step", _choroNumInput(ch), hue(stops[0])];
      for (let i = 1; i < stops.length; i++) ramp.push(stops[i].min, hue(stops[i]));
      // Feature-state values are absent until a parcel is hydrated from the bbox
      // fetch; render those neutral instead of misreading them as the lowest bucket.
      return ch.engine === "feature-state"
        ? ["case", ["==", ["feature-state", ch.stateKey || ch.attribute], null], fallback, ramp]
        : ramp;
    }
    const expr = ["match", _choroKey(ch)];
    (ch.categories || []).forEach((c) => { expr.push(String(c.value), hue(c)); });
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

  // ── Parcel choropleth views (DIC-527) ──────────────────────────────────────
  // A selectable menu of ways to color parcels (Property class, Parcel size,
  // Taxable value/acre, School district, Plain). The active view's config is
  // mirrored onto COUNTY.styling.layers.parcels.choropleth so the existing
  // paint + legend pipeline reads it unchanged. Tile-attribute views paint
  // directly off the vector tiles; assessing views ("feature-state") hydrate
  // per-parcel values from PS_PARCEL_INDEX (the /parcels?bbox= data) onto the
  // parcels source feature-state, keyed on pin (the tile promoteId).
  const _CHORO_LS = "pv-parcel-choro";
  let _activeChoroId = null;
  let _refreshParcelFill = null;   // init assigns updateZoningOpacity (resting fill)

  // Qualitative palette for dynamic categorical views (e.g. school district).
  const _CHORO_DYN_PALETTE = [
    { color: "#4E79A7", colorDark: "#7CA7D0" }, { color: "#F28E2B", colorDark: "#F4A85C" },
    { color: "#59A14F", colorDark: "#7FC077" }, { color: "#B07AA1", colorDark: "#C79BBC" },
    { color: "#E15759", colorDark: "#EC8284" }, { color: "#76B7B2", colorDark: "#9BD0CC" },
    { color: "#EDC948", colorDark: "#E6CB6B" }, { color: "#FF9DA7", colorDark: "#FFB9C0" },
    { color: "#9C755F", colorDark: "#BE9A86" }, { color: "#BAB0AC", colorDark: "#D2CAC6" },
  ];

  function _parcelChoroViews() {
    try { return countyConfig().styling.layers.parcels.choroplethViews || []; } catch (_) { return []; }
  }
  function _findChoroView(id) {
    const vs = _parcelChoroViews();
    return vs.find((v) => v.id === id) || vs.find((v) => v.default) || vs[0] || null;
  }
  function _activeChoroView() { return _findChoroView(_activeChoroId); }
  function _choroIsPlain() { const v = _activeChoroView(); return !!(v && v.engine === "none"); }

  // Persistent value cache for feature-state views (DIC-527). Accumulates every
  // parcel ever returned by /parcels?bbox= (PS_PARCEL_INDEX), keyed by pin, and is
  // never cleared — so coverage grows as the user pans and revisits are instant.
  // The original index-only hydration shaded only the current viewport and lagged
  // the tiles by one move; this caches the values and applies them to whatever the
  // tiles actually render (querySourceFeatures), which is the reliable join.
  const _choroCache = new Map();   // "pin" -> { taxable_value, gis_acres, school_dist }
  // Perf guards (DIC-527): only do hydration work when there's genuinely new data
  // (`_choroDirty`), and never re-`setFeatureState` a parcel already painted for
  // the active slot (`_choroApplied`). Without these, every map settle re-applied
  // state to the whole rendered set — the jank on slower machines.
  let _choroDirty = false;
  const _choroApplied = new Set();   // pins already given feature-state for the active key

  function _mergeChoroCache() {
    const idx = sourceIndex();
    for (const f of idx) {
      const p = f.properties || {};
      const pin = p.pin || p.PIN;
      if (pin == null) continue;
      // A withheld row (ADR 0015) has no value to colour by: keep what's already known
      // rather than overwrite it with blanks.
      if (isWithheld(p) && _choroCache.has(String(pin))) continue;
      _choroCache.set(String(pin), {
        taxable_value: p.taxable_value, gis_acres: p.gis_acres, school_dist: p.school_dist,
      });
    }
  }

  function _choroValue(ch, props) {
    if (!props) return null;
    if (ch.compute === "tmv_per_acre") {
      const tv = +props.taxable_value, ac = +props.gis_acres;
      return (tv > 0 && ac > 0) ? tv / ac : null;
    }
    const v = props[ch.attribute];
    return (v == null || v === "") ? null : v;
  }

  // Build categories for a dynamic categorical view from every value seen so far
  // (the cache), so the legend/colors stay stable as the user pans.
  function _buildDynamicCategories(ch) {
    if (!ch || !ch.dynamic) return;
    const seen = [];
    _choroCache.forEach((props) => {
      const v = props && props[ch.attribute];
      if (v == null || v === "") return;
      const s = String(v);
      if (seen.indexOf(s) === -1) seen.push(s);
    });
    seen.sort();
    ch.categories = seen.map((v, i) => {
      const p = _CHORO_DYN_PALETTE[i % _CHORO_DYN_PALETTE.length];
      return { value: v, label: v, color: p.color, colorDark: p.colorDark };
    });
  }

  // Apply feature-state to the parcels the tiles ACTUALLY render right now
  // (querySourceFeatures), pulling values from the accumulating cache. This is
  // what makes shading match what's on screen instead of trailing the viewport
  // bbox. Cheap + idempotent, so it's safe to call on idle / index refresh.
  function _hydrateChoroState(ch) {
    if (!map || !ch || ch.engine !== "feature-state") return;
    _choroDirty = false;
    const key = ch.stateKey || ch.attribute;
    let feats;
    try { feats = map.querySourceFeatures("parcels", { sourceLayer: "parcels" }); }
    catch (_) { feats = []; }
    for (const f of feats) {
      const pin = f.id != null ? f.id : (f.properties && (f.properties.pin || f.properties.PIN));
      if (pin == null) continue;
      const sp = String(pin);
      if (_choroApplied.has(sp)) continue;       // already painted for this slot
      const val = _choroValue(ch, _choroCache.get(sp));
      if (val == null) continue;                 // not in cache yet → next refresh
      _choroApplied.add(sp);
      try { map.setFeatureState({ source: "parcels", sourceLayer: "parcels", id: pin }, { [key]: val }); }
      catch (_) {}
    }
  }

  // Mirror a view's config to `.choropleth` (null for Plain), preparing dynamic
  // categories / feature-state as needed.
  function _applyChoroConfig(v) {
    const parcels = countyConfig().styling.layers.parcels;
    if (!v || v.engine === "none") { parcels.choropleth = null; return; }
    if (v.dynamic) _buildDynamicCategories(v);
    v.enabled = true;                 // choroplethConfig() gate
    parcels.choropleth = v;
    if (v.engine === "feature-state") _hydrateChoroState(v);
  }

  // Switch the active parcel choropleth view: persist, re-prep, repaint + relegend.
  function setParcelChoroView(id) {
    const v = _findChoroView(id);
    if (!v) return;
    _activeChoroId = v.id;
    try { localStorage.setItem(_CHORO_LS, v.id); } catch (_) {}
    _choroApplied.clear();             // different view = different feature-state slot
    _choroDirty = true;
    if (v.engine === "feature-state") _mergeChoroCache();
    _applyChoroConfig(v);
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    if (map) applyLayerPaint("parcels", countyConfig().styling.layers.parcels, dark);
    updateChoroplethLegend(choroplethLegendSections(stylingLayers(), dark));
    if (_refreshParcelFill) _refreshParcelFill();   // resting fill-opacity (incl. Plain → 0)
    _syncChoroSelector();
    // Pull values for the current view immediately so it shades without waiting
    // for the next pan (refreshParcelIndex fires ps:parcel-index-updated → cache).
    if (v.engine === "feature-state" && typeof refreshParcelIndex === "function") refreshParcelIndex();
  }

  // Pick the active view from localStorage (or the default) and prime `.choropleth`
  // BEFORE the first paint, so the initial render matches the saved view.
  function _initParcelChoro() {
    let saved = null;
    try { saved = localStorage.getItem(_CHORO_LS); } catch (_) {}
    const v = _findChoroView(saved);
    _activeChoroId = v ? v.id : null;
    const cfg = countyConfig();
    if (cfg.styling && cfg.styling.layers && cfg.styling.layers.parcels) {
      _applyChoroConfig(v);
    }
  }
  _initParcelChoro();   // runs at module load, before the map's first applyTheme

  // Render the radio selector of views into the Parcels row body.
  function _buildChoroSelector() {
    const host = document.getElementById("parcels-choro-views");
    if (!host) return;
    host.textContent = "";
    _parcelChoroViews().forEach((v) => {
      const row = document.createElement("label");
      row.className = "choro-view-row";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "parcel-choro-view";
      input.value = v.id;
      input.checked = v.id === _activeChoroId;
      input.addEventListener("change", function () { if (this.checked) setParcelChoroView(v.id); });
      const txt = document.createElement("span");
      txt.textContent = v.label || v.id;
      row.appendChild(input);
      row.appendChild(txt);
      host.appendChild(row);
    });
  }
  function _syncChoroSelector() {
    const host = document.getElementById("parcels-choro-views");
    if (!host) return;
    host.querySelectorAll('input[name="parcel-choro-view"]').forEach((el) => {
      el.checked = el.value === _activeChoroId;
    });
  }

  // Build the selector + wire the Parcels-row chevron + keep feature-state views
  // hydrated as the viewport's parcel index refreshes and new tiles load.
  function _setupParcelChoroUI() {
    _buildChoroSelector();
    _syncChoroSelector();

    // The Parcels-row chevron is toggled by legend-panel.js (the shared
    // .lyr-chevron[data-target] handler) — no wiring needed here.

    // New bbox data arrived (pan/zoom): grow the value cache, refresh dynamic
    // categories, re-hydrate the rendered parcels, repaint + relegend.
    document.addEventListener("ps:parcel-index-updated", function () {
      const v = _activeChoroView();
      if (!v || v.engine !== "feature-state") return;
      const before = _choroCache.size;
      _mergeChoroCache();
      if (_choroCache.size !== before) _choroDirty = true;   // genuinely new values
      if (v.dynamic) { _buildDynamicCategories(v); countyConfig().styling.layers.parcels.choropleth = v; }
      _hydrateChoroState(v);
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      if (map) applyLayerPaint("parcels", countyConfig().styling.layers.parcels, dark);
      updateChoroplethLegend(choroplethLegendSections(stylingLayers(), dark));
    });

    // A new parcels tile finished loading → its features start with empty feature-
    // state, so mark dirty; the next 'idle' re-applies cached values to it.
    if (map) map.on("sourcedata", function (e) {
      if (e.sourceId === "parcels" && e.tile && e.tile.state === "loaded") _choroDirty = true;
    });

    // On settle, re-apply ONLY when something changed (new data/tiles) and a
    // feature-state view is active — the applied-set keeps this near-free after
    // warmup. 'idle' is self-debounced so it never fires mid-interaction.
    if (map) map.on("idle", function () {
      if (!_choroDirty) return;
      const v = _activeChoroView();
      if (v && v.engine === "feature-state") _hydrateChoroState(v);
      else _choroDirty = false;
    });
  }

  // Apply a layer's paint for the active theme: solid fill (or choropleth ramp) +
  // stroke. Each setPaintProperty is guarded so layers not yet on the map are skipped.
  // Adaptive resting parcel outline (owner request 2026-09-25): contrast with the
  // background instead of one fixed color. Light basemap → dark gray line over a
  // faint light halo; dark basemap or aerial → white, slightly transparent so it
  // doesn't glare, over a dark casing. Same light/dark rule as the parcel labels.
  // Selection and hover keep the scheme accent.
  function _parcelLineScheme() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    const aerialEl = document.getElementById("toggle-aerial");
    return (dark || (aerialEl && aerialEl.checked))
      ? { line: "#ffffff", casing: "#111827", rest: 0.72, casingRest: 0.5 }
      : { line: "#374151", casing: "#ffffff", rest: 0.85, casingRest: 0.6 };
  }
  function applyParcelLineColors() {
    if (!map || !map.getLayer("parcels-line")) return;
    const sc = _parcelLineScheme();
    map.setPaintProperty("parcels-line", "line-color", sc.line);
    if (map.getLayer("parcels-line-casing")) map.setPaintProperty("parcels-line-casing", "line-color", sc.casing);
  }

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
      map.setPaintProperty(ids.line, "line-color",
        id === "parcels" ? _parcelLineScheme().line : (tone.stroke || (dark ? "#b8a97a" : "#8a7a55")));
    }
  }

  // Render the choropleth legend into the Parcels row body in the Layers panel
  // (DIC-527 — was a floating overlay on the map that the parcel popup covered).
  // sections = [{ title, rows:[{color,label}] }]. DOM-built so config labels/
  // colors are inserted as text/style, never as HTML.
  function updateChoroplethLegend(sections) {
    const el = document.getElementById("parcels-choro-legend");
    if (!el) return;                     // panel not present yet
    el.textContent = "";
    if (!sections || !sections.length) { el.hidden = true; return; }
    el.hidden = false;
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", sections.map((s) => s.title).join("; ") + " legend");
    sections.forEach((sec, i) => {
      if (i > 0) { const sep = document.createElement("div"); sep.className = "choropleth-legend-sep"; el.appendChild(sep); }
      const title = document.createElement("div");
      title.className = "choropleth-legend-title";
      title.textContent = sec.title;
      el.appendChild(title);
      sec.rows.forEach((r) => {
        const row = document.createElement("div");
        row.className = "choropleth-legend-row";
        row.dataset.testid = "choropleth-legend-row";
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

  // ── Map mood (DIC-509) ─────────────────────────────────────────────────────
  // A "super-theme" above color schemes: a mood bundles typography / texture /
  // stroke overrides ("antique" = parchment ground + hairline strokes). Applied
  // as <html data-mood>; CSS does the ground/typography, here we set the attribute,
  // ensure the parchment overlay element, and tune map strokes. Opt-in, never a
  // county default. Generalizable to field/presentation/blueprint moods later.
  function _ensureMoodOverlay() {
    const host = document.getElementById("panel-map");
    if (!host || document.getElementById("pv-mood-overlay")) return;
    const el = document.createElement("div");
    el.id = "pv-mood-overlay";
    el.className = "pv-mood-overlay";
    el.setAttribute("aria-hidden", "true");
    host.appendChild(el);   // CSS reveals it only for moods that define a ground
  }
  function applyMapMood(mood) {
    mood = mood || "none";
    document.documentElement.setAttribute("data-mood", mood);
    _ensureMoodOverlay();
    // Hairline parcel strokes in antique; restore the style default otherwise.
    // (Stroke WIDTH only — the spotlight owns line-opacity, so no conflict.)
    if (map && map.getLayer("parcels-line")) {
      try {
        map.setPaintProperty("parcels-line", "line-width",
          mood === "antique"
            ? ["interpolate", ["linear"], ["zoom"], 11, 0.2, 14, 0.5, 17, 0.9]
            : ["interpolate", ["linear"], ["zoom"], 11, 0.3, 14, 0.6, 17, 1.2, 19, 2]);
      } catch (_) {}
    }
  }
  window.PS_MAP_MOOD = { apply: applyMapMood, get: function () { return document.documentElement.getAttribute("data-mood") || "none"; } };

  function applyTheme(dark) {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    const moonIcon = document.getElementById("theme-icon-moon");
    const sunIcon  = document.getElementById("theme-icon-sun");
    // These are <svg> elements: `.hidden` is an HTMLElement property and is a NO-OP on
    // SVGElement (it never reflects to the attribute the [hidden] CSS rule keys on), which
    // froze the icon on the moon. Toggle the actual attribute instead. Sun shows in dark
    // (tap to go light), moon shows in light (tap to go dark).
    if (moonIcon) moonIcon.toggleAttribute("hidden", dark);
    if (sunIcon)  sunIcon.toggleAttribute("hidden", !dark);

    if (map) {
      const tiles = BASEMAP_TILES[dark ? "dark" : "light"];
      const baseSrc = map.getSource("esri-canvas");
      if (baseSrc) baseSrc.setTiles(tiles.base);
      const labelSrc = map.getSource("esri-canvas-labels");
      if (labelSrc) labelSrc.setTiles(tiles.labels);

      // Per-layer paint (DIC-460): fill (solid or choropleth ramp) + stroke for
      // every styled layer, from COUNTY.styling.layers. Scales to many layers.
      const _layers = stylingLayers();
      Object.keys(_layers).forEach((id) => applyLayerPaint(id, _layers[id], dark));

      // Map accent chrome (DIC-505): the active color scheme drives selection,
      // hover, and the resting parcel stroke lean. Re-read here so a scheme change
      // ('pv-scheme-change' → applyTheme) re-tints the map live. SEMANTIC colors
      // (resting fill / class wash) are never touched by the accent.
      var _accent = mapAccent("accent", dark ? "#c9684f" : "#A3473B");
      applyParcelLineColors();
      if (_spotlightFn) _spotlightFn();   // resting outline opacity differs light vs dark
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
    const cfg = countyConfig();
    const t = cfg.styling && cfg.styling.theme;
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
    // Manifest-driven boot: if a theme FILE is being loaded (?theme=/localStorage), wait for
    // it before reading PS_MANIFEST (Phase 1+ branding/map/capability/source reads). Resolves
    // immediately for the default COUNTY-assembled boot, so this is a no-op there.
    if (window.PS_MANIFEST_READY && typeof window.PS_MANIFEST_READY.then === "function") {
      try { await window.PS_MANIFEST_READY; } catch (e) {}
    }
    const style = await resolveStyle();
    const cmap = mapConfig();   // manifest.map → COUNTY.map (Phase 1)
    const EXTENT = cmap.extent || [[-86.33, 42.06], [-85.76, 42.43]];

    map = new maplibregl.Map({
      container: "map",
      style: style,
      center: cmap.center || [-86.03, 42.24],
      zoom: cmap.zoom != null ? cmap.zoom : 9,
      preserveDrawingBuffer: true,
      boxZoom: false,  // we use our own box-select; default shift+drag zoom conflicts with shift-click
      // Load more tiles concurrently (default 16) so aerial tiles arrive before
      // the cinematic camera does — fewer mid-flight pop-ins (DIC-528).
      maxParallelImageRequests: 32,
    });

    initCoordReadout();
    map.once("load", applyDeepLink);

    map.on("load", () => {
      requestAnimationFrame(() => {
        map.resize();
        if (_deepLinked) return;   // a shared link set the camera; skip the intro fly-over
        const cam = map.cameraForBounds(EXTENT, { padding: 0 });
        map.flyTo({ center: cam.center, zoom: cam.zoom + 0.5, duration: 1400, curve: 1.4, essential: true });
      });

      // Re-apply theme now that map sources are available
      const savedTheme = localStorage.getItem("pv-theme");
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      applyTheme(savedTheme ? savedTheme === "dark" : countyThemeDefault(prefersDark));

      // Expose map instance for drawing modules and MapControlAPI
      window.PS_MAP = map;

      // Apply the saved map mood (DIC-509) now that the map is ready.
      try { var _pm = prefs(); applyMapMood(_pm && _pm.getMapMood ? _pm.getMapMood() : "none"); } catch (_) {}

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
        if (window.PS_WMS_FEATURE_INFO &&
            typeof window.PS_WMS_FEATURE_INFO.selectVectorFeatureAt === "function" &&
            window.PS_WMS_FEATURE_INFO.selectVectorFeatureAt(e.point)) return;
        const shift = isShiftDown || !!(e.originalEvent && e.originalEvent.shiftKey);
        const id = feature.properties.id;
        if (id == null) return;
        fetchParcel(id)
          .then((full) => {
            if (activeTool === "buffer") {
              // The Selection Tools pane seeds its buffer from the clicked parcel.
              const onSeed = window.PS_SELECT_MAP && window.PS_SELECT_MAP.onBufferSeed;
              if (onSeed) onSeed(full);
              return;
            }
            selectParcel(full.properties, full.geometry, shift);
          })
          .catch((err) => console.warn("parcel fetch:", err));
      });

      // Layer toggles
      const origFillOpacity = map.getPaintProperty("parcels-fill", "fill-opacity");

      // Casing under the parcel outline (color set by applyParcelLineColors: a light
      // halo under the dark line, a dark casing under the white one).
      if (!map.getLayer("parcels-line-casing")) {
        map.addLayer({
          id: "parcels-line-casing", type: "line", source: "parcels", "source-layer": "parcels",
          paint: {
            "line-color": "#1f2937",
            "line-opacity": 0.5,
            "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.9, 14, 1.6, 17, 2.8, 19, 4],
          },
        }, "parcels-line");
      }

      const aerialToggle = document.getElementById("toggle-aerial");
      const zoningToggle = document.getElementById("toggle-zoning");

      // Resting fill opacity (DIC-506): when the property-class wash (a choropleth
      // on the parcels layer) is the resting fill, render it subtle (~0.16) so
      // labels, selection, hover, and overlays read clearly on top. No wash → the
      // original cream/dark opacity from the style.
      function restingFillOpacity() {
        if (_choroIsPlain()) return 0;   // DIC-527: clean outline-only view
        const ch = choroplethConfig((stylingLayers().parcels) || {});
        return (ch && ch.opacity != null) ? ch.opacity : origFillOpacity;
      }

      // MapLibre 6 throws ("this.expression.evaluate is not a function") when one of these
      // opacities goes from a feature-state expression back to a plain number and a feature
      // state then changes: the tiles built for the expression still evaluate it (DIC-2379;
      // 4.7.1 coped). So they stay feature-state expressions: a resting value is a case
      // whose branches are equal. A zoom curve (the style's own fill-opacity is one) must
      // stay the top level of its expression, so there the case goes into each output.
      const stateful = (v) => {
        if (Array.isArray(v)) {
          const interp = /^interpolate/.test(v[0]), step = v[0] === "step";
          const input = interp ? v[2] : step ? v[1] : null;
          if (Array.isArray(input) && input[0] === "zoom") {
            const first = interp ? 4 : 2;   // index of the first output
            return v.map((x, i) => (i >= first && (i - first) % 2 === 0 ? stateful(x) : x));
          }
        }
        return ["case", ["boolean", ["feature-state", "selected"], false], v, v];
      };

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
          map.setPaintProperty("parcels-line-casing", "line-opacity-transition", { duration: dur });
        } catch (_) {}
        const normalFill = zoningToggle.checked && !aerialToggle.checked;
        if (normalFill) {
          map.setPaintProperty("parcels-fill", "fill-opacity",
            active
              ? ["case", ["boolean", ["feature-state", "selected"], false], Math.max(restingFillOpacity(), 0.24), 0.04]
              : stateful(restingFillOpacity()));
        }
        // Unselected outlines recede — but only as far as stays visible. With no
        // fill doing the dimming (Plain view, or aerial where the fill isn't
        // spotlit) the outline IS the parcel, and 0.18 made the rest vanish.
        const outlineOnly = !normalFill || _choroIsPlain();
        const sc = _parcelLineScheme();
        applyParcelLineColors();   // background may have changed (aerial / theme)
        map.setPaintProperty("parcels-line", "line-opacity",
          active
            ? ["case", ["boolean", ["feature-state", "selected"], false], 1, outlineOnly ? Math.min(0.55, sc.rest) : 0.18]
            : stateful(sc.rest));
        if (map.getLayer("parcels-line-casing")) map.setPaintProperty("parcels-line-casing", "line-opacity",
          active
            ? ["case", ["boolean", ["feature-state", "selected"], false], sc.casingRest, outlineOnly ? 0.35 : 0.1]
            : stateful(sc.casingRest));
      };

      function updateZoningOpacity() {
        const zoningOn = zoningToggle.checked;
        const aerialOn = aerialToggle.checked;
        if (!zoningOn) {
          map.setPaintProperty("parcels-fill", "fill-opacity", stateful(0));
        } else if (aerialOn) {
          // Plain view stays outline-only even over aerial (DIC-527).
          map.setPaintProperty("parcels-fill", "fill-opacity", stateful(_choroIsPlain() ? 0 : 0.25));
        }
        // Normal-mode resting fill + the focus/dim spotlight are owned by _spotlightFn.
        _spotlightFn();
      }
      _refreshParcelFill = updateZoningOpacity;   // DIC-527: view switch re-applies fill

      // Programmatic / AI focus handle (DIC-508). Selecting parcels already
      // triggers the spotlight via updateSelectionBadge; Map Buddy focuses by
      // selecting (existing bridge). This re-applies on a "Map reactions" change.
      window.PS_MAP_FOCUS = {
        refresh: function () { if (_spotlightFn) _spotlightFn(); },
        mode: function () { return _effectiveReactions(); },
      };

      aerialToggle.addEventListener("change", (e) => {
        const on = e.target.checked;
        map.setLayoutProperty("mi-aerial", "visibility", on ? "visible" : "none");
        // Stop loading the street basemap while aerial covers it (DIC-528). It's
        // invisible under the opaque imagery, but MapLibre still fetches+decodes
        // its tiles — ~half the tile traffic during a cinematic, competing with
        // the aerial and causing tile aborts/redraw. Hide it → all bandwidth goes
        // to the aerial. (Hillshade, when on, sits above the basemap, unaffected.)
        ["basemap", "basemap-labels"].forEach((id) => {
          if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "none" : "visible");
        });
        if (window.PS_MAP_PANEL) window.PS_MAP_PANEL.layers.aerial = on;
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
        applyParcelLineColors();
        if (window.PS_MAP_PANEL) window.PS_MAP_PANEL.layers.zoning = e.target.checked;
        updateZoningOpacity();
      });

      // Apply the resting fill opacity now (so the class wash loads subtle, not at
      // the heavier default cream opacity — DIC-506).
      updateZoningOpacity();

      // Parcel choropleth views (DIC-527): build the selector, wire the chevron,
      // and keep feature-state views hydrated. The initial paint already reflects
      // the saved view (primed by _initParcelChoro before this load).
      _setupParcelChoroUI();
      updateChoroplethLegend(choroplethLegendSections(stylingLayers(),
        document.documentElement.getAttribute("data-theme") === "dark"));

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

  // ── Parcel info panel ──────────────────────────────────────────────────
  // The panel is a Vue island, frontend/src/parcel-panel/ (DIC-2389): it renders the header,
  // next/previous, the card and the reopen tab. map.js decides when it shows (selection,
  // mobile tabs) through PV_PARCEL_PANEL, and answers its calls through PS_PARCEL_PANEL.
  const panelUi = () => window.PV_PARCEL_PANEL || null;

  // ── Focus management + theme re-render for the parcel region (DIC-385) ──
  let _focusInfoPanelOnShow = false;   // set when opened via the keyboard search path
  let _lastFocusBeforeInfo  = null;    // element to restore focus to on close
  let _lastParcelArgs       = null;    // [pin, p, geometry] for re-render on theme toggle

  // Re-render the open parcel popup (theme change, area-units change, etc.)
  // without stealing focus.
  function rerenderOpenParcel() {
    const ui = panelUi();
    if (ui && ui.isOpen() && _lastParcelArgs) {
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
    // AI mode (B1 / DIC-571). Default ON (owner decision 2026-06-27 — supersedes the
    // original opt-in default): the platform leads with AI on and the startup pill points
    // users to the toggle to turn it off. Precedence: an explicit user choice (localStorage)
    // wins; else the manifest's COUNTY.ai.defaultMode; else 'on'. A deployment that must
    // ship AI-off (procurement) sets COUNTY.ai.defaultMode = 'off'. The AI-optional
    // invariants are unchanged — off still degrades to facts (facts-parity, §4.5/§4.6).
    getAiMode: function () {
      try { var v = localStorage.getItem("pv-ai-mode"); if (v === "on" || v === "off") return v; } catch (_) {}
      var ai = countyConfig().ai || {};
      var d = ai.defaultMode || "on";
      return d === "off" ? "off" : "on";
    },
    setAiMode: function (mode) {
      var m = mode === "on" ? "on" : "off";
      try { localStorage.setItem("pv-ai-mode", m); } catch (_) {}
      try { window.dispatchEvent(new CustomEvent("pv-ai-mode-change", { detail: { mode: m } })); } catch (_) {}
      return m;
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
    // Map mood (DIC-509): super-theme above color schemes. 'none' | 'antique'.
    // Opt-in; never a county default. Device-local.
    getMapMood: function () {
      try { var v = localStorage.getItem("pv-map-mood"); return v === "antique" ? v : "none"; } catch (_) { return "none"; }
    },
    setMapMood: function (v) {
      if (v !== "antique") v = "none";
      try { localStorage.setItem("pv-map-mood", v); } catch (_) {}
      applyMapMood(v);
    },
  };

  // Collapse keeps the selection and leaves the reopen tab; hide closes both.
  function collapseInfoPanel() {
    const ui = panelUi();
    if (ui) ui.collapse();
    if (window.PV_MOBILE_TABS) window.PV_MOBILE_TABS.refresh();
  }

  function expandInfoPanel() {
    const ui = panelUi();
    if (ui) ui.expand();
    if (window.PV_MOBILE_TABS) window.PV_MOBILE_TABS.refresh();
  }

  function hideInfoPanel() {
    const ui = panelUi();
    if (ui) ui.hide();
    if (window.PV_MOBILE_TABS) window.PV_MOBILE_TABS.refresh();
  }

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
  // The card (sections, assessed values, tax description, actions) is a Vue island,
  // frontend/src/parcel-card/ (DIC-2389): showParcelInfo opens the panel and hands it the
  // parcel. Field layout matches the payload returned by GET /parcel/{id}.
  function _parcelDisplayPin(selectionKey, props) {
    const p = props || {};
    return p.parcel_no || p.pin || p.PIN || selectionKey || p.id || "";
  }

  function showParcelInfo(pin, p, geometry) {
    _lastParcelArgs = { pin, p, geometry };   // for re-render on theme toggle
    if (window.PV_PARCEL_CARD) window.PV_PARCEL_CARD.show(pin, p, geometry);

    const ui = panelUi();
    if (ui && !ui.isCollapsed()) {
      ui.open();
      // Mobile: Parcel Info and Map Controls are mutually exclusive top
      // dropdowns — selecting a parcel closes Map Controls so they don't stack.
      if (window.innerWidth <= 640) {
        const mcp = document.getElementById("map-control-panel");
        if (mcp) mcp.hidden = true;
      }
      if (window.PV_MOBILE_TABS) window.PV_MOBILE_TABS.refresh();
      // When opened via the keyboard search path, move focus into the region so
      // screen-reader users land on the new parcel content (DIC-385).
      if (_focusInfoPanelOnShow) { ui.focus(); _focusInfoPanelOnShow = false; }
    }
  }

  // The panel's map side: what the panel island asks map.js for.
  window.PS_PARCEL_PANEL = {
    /** Shows the selection's parcel, if any: for the island when it mounts, in case a
     *  parcel was selected before it did. */
    restore() {
      if (!_lastParcelArgs || !selectedPins.length) return;
      showParcelInfo(_lastParcelArgs.pin, _lastParcelArgs.p, _lastParcelArgs.geometry);
      updateInfoPanelNav();
    },
    /** Next (1) or previous (-1) parcel of a multi-parcel selection. */
    cycle: cycleParcel,
    flyTo: () => flyToActiveParcel(true),
    /** The reopen tab: shows the collapsed panel again. */
    reopen: () => expandInfoPanel(),
    /** The panel's ×: clears the selection, and focus goes back where it came from. */
    close() {
      clearSelectionAll();
      if (_lastFocusBeforeInfo && document.contains(_lastFocusBeforeInfo)) _lastFocusBeforeInfo.focus();
    },
    /** A dialog owns the keyboard while open (the arrow keys don't cycle parcels then). */
    dialogOpen: () => dialogOpen(),
  };

  function updateInfoPanelNav() {
    const ui = panelUi();
    if (ui) ui.setNav(activeInfoIndex, selectedPins.length);
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
    const displayPin = _parcelDisplayPin(pin, p);
    // A4 (DIC-569): build the feature ref once, drive the SelectionManager (→
    // 'selection-changed' on the bus), and emit 'active-feature-changed' so the info
    // panel subscriber renders. Direct fallback if the engine/bus didn't load.
    const _ref = { sourceId: "parcels", id: (p.id != null ? p.id : pin), pin: displayPin, selectionKey: pin, properties: p, geometry: entry.geometry };
    if (window.PS_SELECTION) window.PS_SELECTION.select(_ref);
    if (window.PS_SELECTION && typeof window.PS_SELECTION.setActive === "function") {
      window.PS_SELECTION.setActive(_ref);
    } else if (window.PS_BUS) {
      window.PS_BUS.emit("active-feature-changed", { ref: _ref });
    } else {
      showParcelInfo(pin, p, entry.geometry);
    }

    const [cLng, cLat] = entry.geometry ? computeCentroid(entry.geometry) : [null, null];
    const pBounds      = entry.geometry ? computeBounds(entry.geometry) : [[null,null],[null,null]];

    window.PS_STATE.parcel = {
      id:           p.id ?? null,
      pin:          displayPin,
      parcel_no:    p.parcel_no || displayPin,
      selectionKey: pin,
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
      ? `${n} parcels selected — viewing ${displayPin}`
      : `Parcel ${displayPin} · ${p.owner_name || (isWithheld(p) ? "owner withheld today" : "unknown owner")} · ${acresStr} acres`);

    flyToActiveParcel(false);

    if (window.PS_onParcelSelect) window.PS_onParcelSelect(window.PS_STATE.parcel);
  }

  // ── selectParcel ───────────────────────────────────────────────────────
  function selectParcel(props, geometry, shiftKey) {
    const pin = props.pin || props.PIN || props.parcel_no || props.id;

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
          announceSelectionCleared();
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
      resetSelectionStorage();

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
      resetSelectionStorage();

      addToSelection(pin, feature.properties, feature.geometry);
      updateSelectionBadge();
      showParcelAtIndex(0);
      // The search box opts into a cinematic arrival; other callers (MapBuddy
      // workflows, etc.) get the quick fit so they aren't slowed down.
      if (opts.keepView) {
        // Deep link with its own view: leave the camera where the link put it.
      } else if (opts.cinematic) {
        window.PS_cinematicFlyTo(feature.geometry);
      } else {
        map.fitBounds(computeBounds(feature.geometry), { padding: 80, duration: 800, maxZoom: 17 });
      }
      return feature;
    }).catch((err) => {
      // Search results, bookmarks and Map Buddy all land here. Without this the pick
      // silently did nothing (plus an unhandled rejection) when /parcel/{id} failed.
      _focusInfoPanelOnShow = false;
      console.warn("[map] parcel " + id + " failed to load:", err);
      notifyUser(/\(429\)/.test(String(err && err.message))
        ? "The parcel service is busy. Please wait a moment and try again."
        : "Couldn’t load that parcel. Please try again.");
      return null;
    });
  };

  // Brief, announced message (same look as the menu's toasts).
  function notifyUser(msg) {
    const t = document.createElement("div");
    t.className = "pv-toast";
    t.setAttribute("role", "alert");
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("pv-toast--show"));
    setTimeout(() => { t.classList.remove("pv-toast--show"); setTimeout(() => t.remove(), 320); }, 4000);
  }

  // Pre-warm the browser cache with aerial tiles around `center` across the zoom
  // span of the upcoming cinematic (DIC-528). MapLibre streams tiles in as the
  // camera moves, so a fast multi-zoom fly shows them popping in ("redrawing").
  // Fetching the destination's tile column ahead of time (in parallel with the
  // fly) means those requests hit cache instead of Esri. No-op when aerial hidden.
  function _prefetchAerial(center, zFrom, zTo) {
    if (!map || !map.getLayer("mi-aerial")) return;
    try { if (map.getLayoutProperty("mi-aerial", "visibility") !== "visible") return; } catch (_) { return; }
    const src = map.getSource("mi-aerial");
    let tmpl = src && src.tiles && src.tiles[0];
    if (!tmpl) { try { tmpl = map.getStyle().sources["mi-aerial"].tiles[0]; } catch (_) {} }
    if (!tmpl) return;
    const lng = center[0], latRad = center[1] * Math.PI / 180;
    const lo = Math.max(11, Math.floor(zFrom)), hi = Math.min(19, Math.ceil(zTo));
    for (let z = lo; z <= hi; z++) {
      const n = Math.pow(2, z);
      const cx = Math.floor((lng + 180) / 360 * n);
      const cy = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
      // Widen the grid at the top zooms — the pitched 360° orbit sweeps a sizable
      // footprint there, and those are the tiles that abort/redraw most.
      const r = z >= hi ? 3 : (z >= hi - 1 ? 2 : 1);
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          const url = tmpl.replace("{z}", z).replace("{x}", x).replace("{y}", y);
          const img = new Image();
          img.crossOrigin = "anonymous";   // match MapLibre's CORS raster fetch → shared cache
          img.src = url;
        }
      }
    }
  }

  // Reduce per-frame GPU work during the cinematic (DIC-528). Labels (symbol
  // layers) and the regulatory/PostGIS overlays are the most expensive things
  // MapLibre composites each frame, and they're unreadable/unnecessary while the
  // camera spins — so hide them during the motion and restore on settle. Pure
  // win: zero quality loss (you can't use them mid-spin), lighter on every
  // device, biggest help on weak GPUs. Parcels themselves stay visible.
  let _cineHidden = null;
  function _reduceCinematicDetail(on) {
    if (!map) return;
    if (on) {
      if (_cineHidden) return;                    // already reduced
      const targets = new Set();
      try { (map.getStyle().layers || []).forEach((ly) => { if (ly.type === "symbol") targets.add(ly.id); }); } catch (_) {}
      try { ((window.PS_OVERLAY_LAYERS && PS_OVERLAY_LAYERS.overlays) || []).forEach((o) => targets.add(o.id)); } catch (_) {}
      try {
        const ov = window.PS_PG_LAYERS && PS_PG_LAYERS.overlays;
        const list = typeof ov === "function" ? ov() : (ov || []);
        (list || []).forEach((o) => ["-fill", "-line", "-circle", "-glow", "-casing"].forEach((s) => targets.add(o.id + s)));
      } catch (_) {}
      _cineHidden = [];
      targets.forEach((id) => {
        if (!map.getLayer(id)) return;
        let vis; try { vis = map.getLayoutProperty(id, "visibility"); } catch (_) { return; }
        if (vis !== "none") { _cineHidden.push(id); map.setLayoutProperty(id, "visibility", "none"); }
      });
    } else {
      if (!_cineHidden) return;
      _cineHidden.forEach((id) => { if (map.getLayer(id)) { try { map.setLayoutProperty(id, "visibility", "visible"); } catch (_) {} } });
      _cineHidden = null;
    }
  }

  // Cinematic arrival: tilt into 3-D, fly in, orbit a full 360° around the
  // parcel, then settle back to flat north-up. Cancels on user interaction and
  // honors reduced-motion. Used by parcel search and MapBuddy's "fly to".
  let _cineRAF = null;
  let _cineInteract = null;   // the running arrival's cancel handler, if any
  function _cancelCine() { if (_cineRAF) { cancelAnimationFrame(_cineRAF); _cineRAF = null; } }
  // For interactions the map can't see (e.g. the keyboard-opened right-click menu,
  // DIC-1882): stop the fly-in / orbit so the camera holds still.
  window.PS_cancelCinematic = function () {
    if (!_cineInteract) return;
    _cineInteract();
    if (map) map.stop();
  };
  window.PS_cinematicFlyTo = function (geometry, zoom) {
    if (!map || !geometry) return;
    const [lng, lat] = computeCentroid(geometry);
    const center = [lng, lat];
    let z = zoom;
    if (z == null) {
      const cfb = map.cameraForBounds && map.cameraForBounds(computeBounds(geometry), { padding: 140, maxZoom: 18 });
      z = cfb ? Math.min(cfb.zoom - 0.4, 18) : 17;
    }
    // Warm aerial tiles for the destination across the fly's zoom span before/
    // during the move, so they're cached when the camera arrives (DIC-528).
    _prefetchAerial(center, map.getZoom(), z);

    let reduced = false;
    try { reduced = document.documentElement.classList.contains("pv-a11y-motion") || matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
    _cancelCine();
    if (reduced) { map.easeTo({ center, zoom: z, pitch: 0, bearing: 0, duration: 1000 }); return; }

    // Power users can disable the 360° orbit (Settings): keep a quick fly-in,
    // settle north-up and flat, skip the spin entirely.
    let orbitOn = true;
    try { var _po = prefs(); if (_po && _po.getCinematicOrbit) orbitOn = _po.getCinematicOrbit(); } catch (e) {}
    if (!orbitOn) { map.flyTo({ center, zoom: z, pitch: 0, bearing: 0, speed: 1.2, curve: 1.4, essential: true }); return; }

    const userEvents = ["mousedown", "touchstart", "wheel"];
    let cancelled = false;
    function cleanup() { userEvents.forEach((ev) => map.off(ev, onInteract)); if (_cineInteract === onInteract) _cineInteract = null; }
    // Once cancelled, the fly's moveend (or the safety timer) must not start the spin.
    function onInteract() { cancelled = true; _cancelCine(); cleanup(); _reduceCinematicDetail(false); }
    userEvents.forEach((ev) => map.on(ev, onInteract));
    _cineInteract = onInteract;

    _reduceCinematicDetail(true);   // hide labels/overlays for the fly + spin
    let started = false;
    // Original snappy pace (DIC-528): the slowdown that compensated for tile
    // redraw is no longer needed — basemap-hide, the same-origin aerial cache,
    // and reduce-detail-during-motion carry the smoothness, so keep it brisk.
    map.flyTo({ center, zoom: z, pitch: 60, bearing: 0, speed: 0.85, curve: 1.5, essential: true });
    function orbit() {
      if (started || cancelled) return; started = true;
      const ORBIT_MS = 9000; let t0 = null;
      function frame(ts) {
        if (t0 === null) t0 = ts;
        const k = Math.min((ts - t0) / ORBIT_MS, 1);
        const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        map.setBearing(360 * eased);
        map.setCenter(center);
        map.setPitch(60);  // hold full tilt through the orbit (fly may not have finished tilting)
        if (k < 1) { _cineRAF = requestAnimationFrame(frame); }
        else { _cineRAF = null; cleanup(); _reduceCinematicDetail(false); map.easeTo({ bearing: 0, pitch: 0, duration: 2600 }); }
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

  // The search box is a Vue island, frontend/src/search/ (DIC-2389). Picking a result
  // selects the parcel here, and moves focus into the parcel region once it renders (the
  // keyboard lifeline, DIC-385); closing the panel returns focus to the search box.
  window.PS_SEARCH_MAP = {
    select(parcelId, returnFocusTo) {
      _focusInfoPanelOnShow = true;
      _lastFocusBeforeInfo = returnFocusTo || null;
      window.PS_selectParcelById(parcelId, { cinematic: true });
    },
  };

  // Escape clears the parcel selection (and lifts the focus/dim spotlight) when
  // one is active — a universal "deselect" the map was missing. Ignored while
  // typing in a field so it doesn't fight input/search Escape handling.
  // A dialog/overlay owns the keyboard while open: Esc closes it, and must not also clear
  // the parcel selection behind it (DIC-1873).
  function dialogOpen() {
    return !!document.querySelector(
      ".pv-modal-backdrop, .pv-compare-overlay:not([hidden]), .pv-profile-overlay:not([hidden])");
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !selectedPins.length) return;
    if (dialogOpen()) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (window.PV_SEARCH && window.PV_SEARCH.isOpen()) return;   // search owns Escape first
    clearSelectionAll();
  });

  // ── Map Control Panel ──────────────────────────────────────────────────
  // The panel's header, tabs and Advanced toggle are a Vue island, frontend/src/map-controls/
  // (DIC-2389). PS_MAP_PANEL is the map side Map Buddy and hints use: layer toggles, the
  // selection, and tab switching (forwarded to the island).
  function initMapControlPanel() {
    window.PS_MAP_PANEL = {
      // Tabs and the Advanced toggle are the island's; these forward to it.
      setTab:  function (tabId) { const c = window.PV_MAP_CONTROLS; if (c) c.setTab(tabId); },
      getTab:  function () { const c = window.PV_MAP_CONTROLS; return c ? c.getTab() : "layers"; },
      setAdvancedTools: function (on) { const c = window.PV_MAP_CONTROLS; if (c) c.setAdvanced(on); },
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

  // ── Selection tools: the map side (DIC-2389) ────────────────────────────
  // The Selection Tools pane is a Vue island (frontend/src/select-tools/): it owns the
  // pane (the active tool, the filter and buffer forms, the CSV export). What touches the
  // map stays here: the box and lasso gestures, the buffer highlights, and the selection
  // itself. PS_SELECT_MAP is what the pane calls.

  // Adds features to the selection and shows the first new one; returns how many were new.
  function addFeaturesToSelection(features) {
    const firstIdx = selectedPins.length;
    let added = 0;
    for (const f of features) {
      if (addToSelection(f.properties.pin || f.properties.PIN, f.properties, f.geometry)) added++;
    }
    updateSelectionBadge();
    if (added > 0) showParcelAtIndex(firstIdx);
    return added;
  }

  // Removes pins from the selection; returns how many were in it. The info panel then
  // keeps its parcel if it survived, moves to the first one left, or closes.
  function removePinsFromSelection(pins) {
    let removed = 0;
    for (const pin of pins) if (removeFromSelection(pin)) removed++;
    if (removed === 0) return 0;
    updateSelectionBadge();
    if (selectedPins.length === 0) {
      setActiveInfoPin(null);
      hideInfoPanel();
      setStatusStrip(DEFAULT_STATUS);
      window.PS_STATE.parcel = null;
      announceSelectionCleared();
    } else if (!selectedPins.includes(activeInfoPin)) {
      showParcelAtIndex(0);
    } else {
      activeInfoIndex = selectedPins.indexOf(activeInfoPin);
      updateInfoPanelNav();
    }
    return removed;
  }

  // Arms a tool's map side: box and lasso take the pointer (no panning), buffer takes
  // map clicks as seeds (the parcel click handler checks activeTool).
  function setSpatialTool(tool) {
    activeTool = tool || null;
    const lassoCanvas = document.getElementById("lasso-canvas");
    const boxOverlay  = document.getElementById("box-select-overlay");
    if (lassoCanvas) {
      lassoCanvas.style.pointerEvents = tool === "lasso" ? "all" : "none";
      if (tool !== "lasso") lassoCanvas.getContext("2d").clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
    }
    if (boxOverlay) {
      // display:none blocks pointer-events regardless of the property, so set both
      boxOverlay.style.display       = tool === "box" ? "block" : "none";
      boxOverlay.style.pointerEvents = tool === "box" ? "all"   : "none";
    }
    if (!map) return;
    if (tool === "box" || tool === "lasso") {
      map.dragPan.disable();
      map.getCanvas().style.cursor = "crosshair";
    } else if (tool === "buffer") {
      map.dragPan.enable();
      map.getCanvas().style.cursor = "crosshair";
    } else {
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
    }
  }

  function setParcelState(pin, state) {
    if (map && pin != null) map.setFeatureState({ source: "parcels", sourceLayer: SOURCE_LAYER, id: pin }, state);
  }

  window.PS_SELECT_MAP = {
    /** The parcels in the viewport index (the tools select from these). */
    parcels: () => parcelIndex,
    /** How many parcels are selected. */
    selectionSize: () => selectedPins.length,
    /** The selected parcels' properties, in selection order. */
    selectedRecords: () => selectedPins.map((pin) => (selectedFeatureMap.get(pin) || {}).props).filter(Boolean),
    /** The parcel in the info panel, as a feature, or null. */
    activeParcel() {
      const cur = activeInfoPin && selectedFeatureMap.get(activeInfoPin);
      return cur && cur.geometry ? { properties: cur.props, geometry: cur.geometry } : null;
    },
    add: addFeaturesToSelection,
    remove: removePinsFromSelection,
    clear: clearSelectionAll,
    setTool: setSpatialTool,
    /** Highlights the buffer's seed parcel (null: none). */
    setBufferSeed(pin) {
      setParcelState(bufferSeedPin, { bufferSeed: false });
      bufferSeedPin = pin || null;
      setParcelState(bufferSeedPin, { bufferSeed: true });
    },
    /** Draws the buffer polygon and highlights the parcels in it (null: clears both). */
    setBufferPreview(polygon, pins) {
      for (const pin of bufferPreviewPins) setParcelState(pin, { bufferPreview: false });
      bufferPreviewPins = polygon ? (pins || []).slice() : [];
      for (const pin of bufferPreviewPins) setParcelState(pin, { bufferPreview: true });
      const src = map && map.getSource("buffer-preview-source");
      if (src) src.setData({ type: "FeatureCollection", features: polygon ? [polygon] : [] });
    },
    /** Set by the pane: called with the clicked parcel while the buffer tool is armed. */
    onBufferSeed: null,
    notify: (msg) => notifyUser(msg),
  };

  // The box and lasso gestures: drawn on overlays above the map while their tool is armed.
  function initSelectionGestures() {
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

        addFeaturesToSelection(parcelIndex.filter((f) => {
          const [lng, lat] = computeCentroid(f.geometry);
          return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
        }));

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

        let inside = [];
        if (typeof turf !== "undefined") {
          try {
            const polygon = turf.polygon([ring]);
            inside = parcelIndex.filter((f) => turf.booleanPointInPolygon(turf.point(computeCentroid(f.geometry)), polygon));
          } catch (_) {}
        }
        addFeaturesToSelection(inside);

        if (lassoCtx) lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
        lassoPoints = [];
      });
    }
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

    const isMobile     = () => window.innerWidth <= 640;
    const controlsOpen = () => mcpPanel && !mcpPanel.hidden;
    const parcelOpen   = () => !!(panelUi() && panelUi().isOpen());
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

    // The tabs are role="tab": keep aria-selected in step with the visual state, or
    // screen readers announce every tab as "not selected" (DIC-1873).
    function setTab(tab, on) {
      if (!tab) return;
      tab.classList.toggle("active", on);
      tab.setAttribute("aria-selected", String(on));
    }
    function refresh() {
      if (tabParcel) tabParcel.disabled = !hasParcel();
      setTab(tabParcel, parcelOpen());
      setTab(tabControls, controlsOpen());
      setTab(tabBuddy, buddyOpen());
    }

    window.PV_MOBILE_TABS = { refresh };

    // Start with everything closed on mobile.
    if (isMobile() && mcpPanel) mcpPanel.hidden = true;
    refresh();
  }

  // ── Deep links (Share) ────────────────────────────────────────────────
  // ?parcel=<id> reopens a parcel; ?view=<lng>,<lat>,<zoom> restores the map position.
  // Share used to copy location.href, which never carried either, so every shared link
  // opened the default county view. Values are validated; anything malformed is ignored.
  function viewLink() {
    const u = new URL(window.location.href);
    u.hash = "";
    u.searchParams.delete("parcel");
    u.searchParams.delete("view");
    const sel = window.PS_STATE && window.PS_STATE.parcel;
    if (sel && sel.id != null) u.searchParams.set("parcel", String(sel.id));
    if (map) {
      const c = map.getCenter();
      u.searchParams.set("view", [c.lng.toFixed(5), c.lat.toFixed(5), map.getZoom().toFixed(2)].join(","));
    }
    return u.toString();
  }
  window.PV_VIEW_LINK = viewLink;

  let _deepLinked = false;   // set when the URL placed the camera (suppresses the intro fly)
  function applyDeepLink() {
    let params;
    try { params = new URL(window.location.href).searchParams; } catch (_) { return; }
    const view = (params.get("view") || "").split(",").map(Number);
    if (view.length === 3 && view.every(Number.isFinite) &&
        Math.abs(view[0]) <= 180 && Math.abs(view[1]) <= 90 && view[2] >= 0 && view[2] <= 22) {
      map.jumpTo({ center: [view[0], view[1]], zoom: view[2] });
      _deepLinked = true;
    }
    const parcel = params.get("parcel");
    if (parcel && /^\d+$/.test(parcel)) {
      // Keep the shared view when one was given; otherwise fit to the parcel.
      _deepLinked = true;
      window.PS_selectParcelById(Number(parcel), { keepView: view.length === 3 && view.every(Number.isFinite) });
    }
  }

  // The map can't start (API down, style.json failing, MapLibre missing). Without this the
  // page stayed blank with only an unhandled rejection in the console (DIC-1856).
  function showMapLoadError(err) {
    console.error("[map] failed to load:", err);
    const host = document.getElementById("map");
    if (!host || document.getElementById("pv-map-error")) return;
    const box = document.createElement("div");
    box.id = "pv-map-error";
    box.className = "pv-map-error";
    box.setAttribute("role", "alert");
    box.innerHTML =
      '<p class="pv-map-error-title">The map couldn’t load</p>' +
      '<p class="pv-map-error-text">The parcel service may be busy or offline. Check your connection and try again.</p>' +
      '<button type="button" class="pv-map-error-retry">Try again</button>';
    box.querySelector("button").addEventListener("click", () => window.location.reload());
    host.appendChild(box);
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────
  initTheme();
  initMap().catch(showMapLoadError);
  initMapControlPanel();
  initSelectionGestures();
  initMobileTabs();
})();
