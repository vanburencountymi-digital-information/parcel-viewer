/**
 * manifest-assemble.js — assemble a §5 theme manifest from console editor config (B2 / DIC-578).
 *
 * The Admin Console's module-editors (county/branding, styling, data & layers, intelligence,
 * access) each edit a slice of a county-config object. B2's manual builder UNIFIES those
 * slices into ONE versioned, exportable theme manifest (§7) — this is the assembler that
 * does the mapping, plus the pieces no module owns: capability selection + per-capability AI
 * tri-state (from the capability catalog) + persona.
 *
 * Source-agnostic (§4.1): this file maps GENERIC config shapes — `data.baseLayers`,
 * `data.overlays`, a `schemes`/active-scheme branding block — into the manifest's
 * `sources`/`branding`/etc. It hardcodes no domain noun; the only domain vocabulary lives in
 * the capability catalog (a data module). The output is a CURRENT_VERSION manifest meant to
 * be handed straight to loadManifest() (migrate-on-load → validate), so the composer always
 * round-trips through the same gate CI uses.
 *
 * assembleManifest(config, opts) -> manifest (a plain object; NOT yet validated — the caller
 * runs it through ISV_LOAD_MANIFEST.loadManifest to validate, same as every other consumer).
 *
 * UMD: Node module (harness) + browser global (window.ISV_MANIFEST_ASSEMBLE).
 */
(function (root, factory) {
  'use strict';
  var mod = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_MANIFEST_ASSEMBLE = mod;
}(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  function req(nodePath, globalName) {
    if (typeof module !== 'undefined' && module.exports) return require(nodePath);
    return root[globalName];
  }
  var MV = req('./manifest-version.js', 'ISV_MANIFEST_VERSION');
  var CATALOG = req('./capability-catalog.js', 'ISV_CAPABILITY_CATALOG');

  function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
  function slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // Map an editor layer-type token onto a manifest source `type`
  // (schema enum: vector | raster | wms | geojson). Unknowns fall back to 'vector'.
  function normType(t) {
    var k = String(t || '').toLowerCase();
    if (k === 'wms') return 'wms';
    if (k === 'raster' || k === 'imagery' || k === 'aerial') return 'raster';
    if (k === 'geojson') return 'geojson';
    return 'vector';
  }

  // Collect manifest `sources` from a generic config. If the config already carries a
  // §5 `sources` array (e.g. a real manifest being re-edited), trust it. Otherwise derive
  // from the Data & Layers editor's arrays: base layers first (the primary data), then
  // overlays. Each becomes { id, type, [label], [sourceLayer], [minZoom], [legend] }.
  function collectSources(config, opts) {
    if (Array.isArray(config.sources) && config.sources.length) return config.sources.slice();

    var idFields = (opts && opts.idFields) || {};
    // The Data & Layers editor stores its arrays under `layers` (county-config.js:
    // layers.baseLayers / layers.overlays); `data` is accepted as an alias.
    var data = config.layers || config.data || {};
    var seen = {};
    var sources = [];

    function push(entry, defaultType) {
      if (!entry || !entry.id || seen[entry.id]) return;
      seen[entry.id] = true;
      var src = { id: entry.id, type: normType(entry.type || defaultType) };
      if (entry.label) src.label = entry.label;
      if (entry.sourceLayer) src.sourceLayer = entry.sourceLayer;
      var mz = (entry.minZoom != null) ? entry.minZoom : entry.minzoom;
      if (mz != null) src.minZoom = mz;
      if (entry.source) src.legend = entry.source;       // editor's human source note → legend
      if (idFields[entry.id]) src.idField = idFields[entry.id];
      sources.push(src);
    }

    (data.baseLayers || []).forEach(function (b) { push(b, 'vector'); });
    (data.overlays || []).forEach(function (o) { push(o, 'vector'); });
    return sources;
  }

  // Resolve the active color scheme into branding theme tokens. Generic over a
  // `styling.schemes` list keyed by `colorScheme`; absent → no theme tokens.
  function brandingTheme(config) {
    var st = config.styling || {};
    var schemes = st.schemes || [];
    var activeId = st.colorScheme;
    for (var i = 0; i < schemes.length; i++) {
      if (schemes[i].id === activeId) {
        var s = schemes[i];
        var theme = {};
        if (s.interactive) theme['--ui-interactive'] = s.interactive;
        if (s.accent) theme['--ui-accent'] = s.accent;
        return theme;
      }
    }
    return null;
  }

  // assembleManifest(config, opts)
  //   config — a county-config / editor-state object (or an existing manifest being re-edited)
  //   opts   — { tenant, id, persona, capabilityIds, capabilityOverrides, idFields }
  function assembleManifest(config, opts) {
    config = isObj(config) ? config : {};
    opts = opts || {};

    var tenant = opts.tenant || config.tenant || slug(config.name);
    var id = opts.id || config.id || ('viewer-' + (tenant || 'untitled'));

    var manifest = {
      manifestVersion: (MV && MV.CURRENT_VERSION) || '1.0',
      id: id,
      tenant: tenant,
    };

    // branding — name + attribution + theme tokens.
    var branding = {};
    if (config.name) branding.name = config.name;
    if (config.attribution || (config.branding && config.branding.attribution)) {
      branding.attribution = config.attribution || config.branding.attribution;
    }
    if (config.branding && config.branding.logo) branding.logo = config.branding.logo;
    var theme = brandingTheme(config);
    if (theme) branding.theme = theme;
    if (Object.keys(branding).length) manifest.branding = branding;

    // map — center / zoom / extent.
    var m = config.map || {};
    manifest.map = {
      center: Array.isArray(m.center) ? m.center.slice() : undefined,
      zoom: (typeof m.zoom === 'number') ? m.zoom : undefined,
    };
    if (Array.isArray(m.extent)) manifest.map.extent = m.extent;

    // sources — derived from the Data & Layers editor (or passed through).
    manifest.sources = collectSources(config, opts);

    // capabilities — the piece no module owns: selection + per-capability AI tri-state.
    if (isObj(opts.capabilities)) {
      manifest.capabilities = opts.capabilities;       // explicit override (already shaped)
    } else if (CATALOG) {
      manifest.capabilities = CATALOG.defaultCapabilities(opts.capabilityIds, opts.capabilityOverrides);
    } else {
      manifest.capabilities = {};
    }

    // persona — voice + audience. Default audience from the access model when public.
    var persona = opts.persona || config.persona || null;
    if (!persona) {
      var pub = config.access && /public/i.test(String(config.access.model || ''));
      persona = { audience: pub ? 'public' : 'staff' };
    }
    manifest.persona = persona;

    // mapBuddy / AI endpoint passthrough (per-deployment), if present.
    var mb = (config.endpoints && config.endpoints.mapBuddy) || (config.mapBuddy && config.mapBuddy.apiBase);
    if (mb) manifest.mapBuddy = { apiBase: mb };

    // Generic passthrough: copy the named config keys onto the manifest verbatim. The
    // viewer (which knows its own config shape) names these county-specific blocks, so the
    // manifest can be a COMPLETE superset the viewer boots from, while the engine assembler
    // stays source-agnostic (no domain field names hardcoded here, §4.1).
    (opts.passthrough || []).forEach(function (k) {
      if (config[k] !== undefined && !(k in manifest)) manifest[k] = config[k];
    });

    return manifest;
  }

  return { assembleManifest: assembleManifest, normType: normType };
}));
