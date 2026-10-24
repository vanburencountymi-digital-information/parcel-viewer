/* Map Buddy's map commands (moved out of map-buddy.js in DIC-2389).
 *
 * The AI returns structured "commands"; these run them against the live map (PS_MAP),
 * the parcel layer, the overlay registry, and the drawing/measure engine
 * (PS_MAP_CONTROL_API). Each returns a short chip label shown under the AI message, so
 * the user sees what the assistant did. A few (measurements, search, a tour's notes)
 * add their own bubble with their result.
 *
 * Plain JavaScript on purpose: Map Buddy's panel is moving to Vue, the map side stays
 * here (as map.js keeps the map). The panel hands create() a small adapter, `ui`:
 *   currentParcel()     the parcel Map Buddy is talking about, or null
 *   info(html)          a secondary bubble (html is built here, every value escaped)
 *   results(html)       the same, with .mb-result-btn[data-pin] buttons → selectResult(pin)
 *   suggest(list)       tappable next steps (strings or { label, prompt })
 *   requestLook(q)      the AI asked to look at the map: look after this reply
 *   offerLook(q)        the AI offers a look: one button, at most once per conversation
 * and gets back { run(commands) → chip labels, buildMapState(), cancelCinematic(),
 * selectResult(pin) }.
 *
 * Loaded before map-buddy.js; publishes window.PV_MAP_BUDDY_COMMANDS.create.
 */
(function (root) {
  'use strict';

  function _escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function create(ui) {
    function _parcel() { return ui.currentParcel(); }

    // The AI returns structured "commands"; we execute them against the live map
    // (PS_MAP), the parcel layer, the overlay registry, and the drawing/measure
    // engine (PS_MAP_CONTROL_API). Each command returns a short chip label shown
    // under the AI message so the user sees what the assistant did. A few
    // commands (measurements, search) append their own info bubble, because the
    // single-shot model can't see their result.

    function _map()  { return root.PS_MAP || null; }
    function _api()  { return root.PS_MAP_CONTROL_API || null; }
    function _turf() { return (typeof turf !== 'undefined') ? turf : null; }

    // Resolve a parcel GeoJSON feature by PIN, defaulting to the selected parcel.
    function _resolveParcel(pin) {
      // PS_STATE.parcel is the viewer's selection (PS_SELECTED_PIN was never set anywhere).
      var sel = root.PS_STATE && root.PS_STATE.parcel;
      var want = pin || (_parcel() && _parcel().pin) || (sel && sel.pin);
      if (!want) return null;
      // Prefer the selected parcel's full record — it carries geometry and is
      // independent of which tiles are loaded into PS_PARCEL_INDEX, so "this
      // parcel" resolves even after the user has panned/zoomed away.
      if (_parcel() && _parcel().geometry &&
          (!pin || String(_parcel().pin) === String(want))) {
        return { type: 'Feature', properties: { pin: _parcel().pin }, geometry: _parcel().geometry };
      }
      var idx = root.PS_PARCEL_INDEX || [];
      for (var i = 0; i < idx.length; i++) {
        var pr = idx[i].properties || {};
        if (String(pr.pin || pr.PIN) === String(want)) return idx[i];
      }
      return null;
    }
    function _parcelCentroid(f) {
      var t = _turf(); if (!f || !t) return null;
      try { return t.centroid(f).geometry.coordinates; } catch (e) { return null; }
    }
    // Accept [lng,lat] | {lng,lat} | {lon,lat} → [lng,lat]
    function _coordsOf(p) {
      if (p == null) return null;
      if (Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number') return [p[0], p[1]];
      if (typeof p.lng === 'number' && typeof p.lat === 'number') return [p.lng, p.lat];
      if (typeof p.lon === 'number' && typeof p.lat === 'number') return [p.lon, p.lat];
      return null;
    }
    function _ft2mi(ft) { return ft / 5280; }
    function _fmtFt(ft) { return ft >= 5280 ? (ft / 5280).toFixed(2) + ' mi' : Math.round(ft) + ' ft'; }

    // Friendly layer names → overlay-registry ids.
    var _LAYER_ALIASES = {
      flood: 'overlay-flood', floodplain: 'overlay-flood', fema: 'overlay-flood', 'flood-hazard': 'overlay-flood',
      wetlands: 'overlay-wetlands', wetland: 'overlay-wetlands', nwi: 'overlay-wetlands',
      soils: 'overlay-soils', soil: 'overlay-soils', ssurgo: 'overlay-soils',
      hillshade: 'overlay-hillshade', terrain: 'overlay-hillshade', shade: 'overlay-hillshade',
      contours: 'overlay-contours-10ft', 'contours-10ft': 'overlay-contours-10ft',
      'contours-5ft': 'overlay-contours-5ft', 'contours-2ft': 'overlay-contours-2ft',
      drains: 'county-drains', drain: 'county-drains',
      roads: 'county-roads', road: 'county-roads', 'road-centerlines': 'county-roads',
      'section-lines': 'county-section-lines', 'plss-section-lines': 'county-section-lines',
      sections: 'county-plss-sections', 'plss-sections': 'county-plss-sections',
      subdivisions: 'county-subdivisions', subdivision: 'county-subdivisions',
      'address-points': 'county-address-points', addresses: 'county-address-points',
      'parcel-points': 'county-parcel-points',
      'plss-corners': 'county-plss-corners', corners: 'county-plss-corners',
      'section-centers': 'county-section-centers',
    };
    var _LAYER_LABEL = {
      'overlay-flood': 'Flood Hazard', 'overlay-wetlands': 'Wetlands', 'overlay-soils': 'Soils',
      'overlay-hillshade': 'Hillshade', 'overlay-contours-10ft': 'Contours 10ft',
      'overlay-contours-5ft': 'Contours 5ft', 'overlay-contours-2ft': 'Contours 2ft',
      'county-drains': 'Drains', 'county-roads': 'Road centerlines',
      'county-section-lines': 'PLSS section lines', 'county-plss-sections': 'PLSS sections',
      'county-subdivisions': 'Subdivisions', 'county-address-points': 'Address points',
      'county-parcel-points': 'Parcel points', 'county-plss-corners': 'PLSS corners',
      'county-section-centers': 'Section centers',
    };
    function _resolveLayerId(id) {
      if (!id) return null;
      var key = String(id).toLowerCase().replace(/[_\s]+/g, '-');
      if (_LAYER_ALIASES[key]) return _LAYER_ALIASES[key];
      if (key.indexOf('overlay-') === 0 || key.indexOf('county-') === 0) return key;
      return null;
    }
    function _setLayer(id, visible) {
      var oid = _resolveLayerId(id);
      if (oid && oid.indexOf('county-') === 0 && root.PS_COUNTY_LAYERS && root.PS_COUNTY_LAYERS.setLayer) {
        root.PS_COUNTY_LAYERS.setLayer(oid, !!visible); return oid;
      }
      if (oid && root.PS_OVERLAY_LAYERS && root.PS_OVERLAY_LAYERS.setOverlay) {
        root.PS_OVERLAY_LAYERS.setOverlay(oid, !!visible); return oid;
      }
      var cb = document.getElementById((oid || ('overlay-' + id)) + '-toggle');
      if (cb) {
        if (cb.checked !== !!visible) { cb.checked = !!visible; cb.dispatchEvent(new Event('change')); }
        return oid || id;
      }
      return null;
    }

    // Build annotation properties (label + style) from a command payload.
    function _annProps(p, type) {
      var props = { featureType: type };
      if (p.label) props.label = p.label;
      var style = {};
      if (p.color)      { style.strokeColor = p.color; style.fontColor = p.color; }
      if (p.fill_color) { style.fillColor = p.fill_color; style.fillOpacity = 0.22; }
      if (style.strokeColor || style.fillColor) props.style = style;
      return props;
    }

    // Flashy expanding ring at a parcel centroid when the AI highlights it.
    function _pulse(pin) {
      var m = _map(), c = _parcelCentroid(_resolveParcel(pin));
      if (!m || !c || typeof maplibregl === 'undefined') return;
      try {
        var dot = document.createElement('div'); dot.className = 'mb-pulse';
        var mk = new maplibregl.Marker({ element: dot }).setLngLat(c).addTo(m);
        setTimeout(function () { try { mk.remove(); } catch (e) {} }, 1700);
      } catch (e) {}
    }

    // Camera ops within one AI reply are coalesced into a single cinematic move —
    // issuing separate flyTo/easeTo calls back-to-back makes them interrupt each
    // other (only the last survives). Each camera command records intent on _cam;
    // _flushCamera() resolves one combined animation after the batch runs.
    var _cam = null;
    function _camIntent() { _cam = _cam || {}; return _cam; }

    // Cinematic fly-around: tilt into 3-D, fly to the parcel, orbit a full 360°,
    // then settle back to a flat north-up view. Honors reduced-motion.
    var _cineRAF = null;
    function _cancelCinematic() { if (_cineRAF) { cancelAnimationFrame(_cineRAF); _cineRAF = null; } }
    function _runCinematic(m, center, zoom) {
      var reduced = false;
      try { reduced = document.documentElement.classList.contains('pv-a11y-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
      if (reduced) { m.easeTo({ center: center, zoom: zoom, pitch: 0, bearing: 0, duration: 1200, essential: true }); return; }
      _cancelCinematic();
      var ORBIT_MS = 9000, started = false;
      m.flyTo({ center: center, zoom: zoom, pitch: 60, bearing: 0, speed: 0.85, curve: 1.5, essential: true });
      function orbit() {
        if (started) return; started = true;
        var t0 = null;
        function frame(ts) {
          if (t0 === null) t0 = ts;
          var k = Math.min((ts - t0) / ORBIT_MS, 1);
          var eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;  // ease in-out
          m.setBearing(360 * eased);
          m.setCenter(center);
          if (k < 1) { _cineRAF = requestAnimationFrame(frame); }
          else { _cineRAF = null; m.easeTo({ bearing: 0, pitch: 0, duration: 2600, essential: true }); }
        }
        _cineRAF = requestAnimationFrame(frame);
      }
      m.once('moveend', orbit);
      setTimeout(orbit, 2600);  // fallback if moveend doesn't fire (already in place)
    }
    function _flushCamera() {
      var m = _map(), cam = _cam; _cam = null;
      if (!m || !cam) return;
      var opts = { duration: 1100, essential: true };

      // Resolve a "fit" (parcel bbox or all annotations) into center+zoom so it can
      // merge with tilt/rotate in a single easeTo.
      var bounds = null, t = _turf();
      if (cam.fitParcel !== undefined && t) {
        var f = _resolveParcel(cam.fitParcel);
        if (f) { var bb = t.bbox(f); bounds = [[bb[0], bb[1]], [bb[2], bb[3]]]; }
      } else if (cam.fitAnnotations && t) {
        var a = _api();
        if (a) { var fc = a.getAnnotations(); if (fc.features.length) { var ab = t.bbox(fc); bounds = [[ab[0], ab[1]], [ab[2], ab[3]]]; } }
      }
      if (bounds && m.cameraForBounds) {
        var cfb = m.cameraForBounds(bounds, { padding: 70, maxZoom: 18 });
        if (cfb) { opts.center = cfb.center; opts.zoom = cfb.zoom; }
      }
      if (cam.center)            opts.center  = cam.center;
      if (cam.zoom != null)      opts.zoom    = cam.zoom;
      else if (cam.zoomDelta != null) opts.zoom = m.getZoom() + cam.zoomDelta;
      if (cam.bearing != null)   opts.bearing = cam.bearing;
      if (cam.pitch != null)     opts.pitch   = Math.max(0, Math.min(85, cam.pitch));
      if (opts.center || opts.zoom != null || opts.bearing != null || opts.pitch != null) m.easeTo(opts);
    }

    // Command registry: name → fn(payload) → chip label (or null if it no-oped).
    var _CMDS = {
      // ── Camera (coalesced — see _flushCamera) ─────────────────────────────────
      fly_to_coordinates: function (p) { var c = _coordsOf(p); if (!c) return null; var k = _camIntent(); k.center = c; if (p.zoom != null) k.zoom = p.zoom; else if (k.zoom == null) k.zoom = Math.max(_map() ? _map().getZoom() : 16, 16); return '🛰️ Flew to location'; },
      fly_to_parcel: function (p) { var f = _resolveParcel(p.pin); _camIntent().fitParcel = f ? (f.properties.pin || f.properties.PIN) : (p.pin || null); return '🛰️ Zoomed to parcel' + (f ? ' ' + (f.properties.pin || f.properties.PIN) : ''); },
      fit_map_to_parcel: function () { _camIntent().fitParcel = null; return '🛰️ Fit parcel in view'; },
      cinematic_fly_to_parcel: function (p) {
        var m = _map(), f = _resolveParcel(p.pin), t = _turf();
        if (!m || !f || !t) { _camIntent().fitParcel = (p.pin || null); return '🎬 Flying to parcel'; }
        // Prefer the viewer's shared cinematic (interaction-cancel, reduced-motion).
        if (root.PS_cinematicFlyTo && f.geometry) { _cam = null; root.PS_cinematicFlyTo(f.geometry); return '🎬 Cinematic fly-around of ' + (f.properties.pin || f.properties.PIN); }
        var bb = t.bbox(f), center = _parcelCentroid(f) || [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
        var zoom = 17;
        if (m.cameraForBounds) { var cfb = m.cameraForBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 140, maxZoom: 18 }); if (cfb) zoom = Math.min(cfb.zoom - 0.4, 18); }
        _cam = null;  // the cinematic sequence owns the camera
        _runCinematic(m, center, zoom);
        return '🎬 Cinematic fly-around of ' + (f.properties.pin || f.properties.PIN);
      },
      zoom_to:  function (p) { if (p.zoom == null) return null; _camIntent().zoom = p.zoom; return '🔍 Zoom ' + Math.round(p.zoom); },
      zoom_by:  function (p) { if (p.delta == null) return null; _camIntent().zoomDelta = p.delta; return p.delta >= 0 ? '🔍 Zoomed in' : '🔍 Zoomed out'; },
      set_pitch: function (p) { if (p.pitch == null) return null; _camIntent().pitch = p.pitch; return '🧭 Tilt ' + Math.round(p.pitch) + '°'; },
      set_bearing: function (p) { if (p.bearing == null) return null; _camIntent().bearing = p.bearing; return '🧭 Rotate ' + Math.round(p.bearing) + '°'; },
      reset_north: function () { var k = _camIntent(); k.bearing = 0; k.pitch = 0; return '🧭 North up'; },
      fit_to_annotations: function () { _camIntent().fitAnnotations = true; return '🖼️ Fit drawings'; },

      // ── Selection ─────────────────────────────────────────────────────────────
      select_parcel: function (p) {
        // Prefer DB id (from a backend search) — works even for parcels not in the
        // currently loaded tiles; fall back to PIN lookup within the loaded index.
        // The id comes from model output and becomes part of a URL path: digits only (DIC-1870).
        if (p.id != null && /^\d+$/.test(String(p.id)) && root.PS_selectParcelById) { root.PS_selectParcelById(p.id); return '📍 Selected ' + (p.pin || p.id); }
        if (p.pin && root.PS_selectParcel) { root.PS_selectParcel(p.pin); return '📍 Selected ' + p.pin; }
        return null;
      },
      select_parcel_on_map: function (p) { return _CMDS.select_parcel(p); },
      highlight_parcel:     function (p) { if (p.pin && root.PS_highlightParcel) { root.PS_highlightParcel(p.pin); _pulse(p.pin); return '✨ Highlighted ' + p.pin; } return null; },

      // ── Layers ────────────────────────────────────────────────────────────────
      set_layer_visibility: function (p) {
        var oid = _setLayer(p.layer_id, p.visible); if (!oid) return null;
        var name = _LAYER_LABEL[oid] || p.layer_id;
        return (p.visible ? '🌊 ' : '🚫 ') + name + (p.visible ? ' on' : ' off');
      },
      // Reactive cartography (DIC-515): bloom an overlay the AI is *talking about*
      // so the eye follows the words. PS_pulseOverlay ensures the layer is on,
      // pulses it, and self-gates on the "Map reactions" setting + reduced-motion
      // (Off = silent no-op). It resolves WMS rasters and PostGIS layers alike, so
      // pass the friendly name straight through (alias-map first for a tidy chip).
      pulse_layer: function (p) {
        var ref = p.layer_id;
        if (!ref || !root.PS_pulseOverlay) return null;
        var oid = _resolveLayerId(ref) || ref;
        if (!root.PS_pulseOverlay(oid)) return null;
        return '💫 ' + (_LAYER_LABEL[oid] || ref);
      },

      // ── Drawing ───────────────────────────────────────────────────────────────
      draw_point:  function (p) { var a = _api(), c = _coordsOf(p); if (!a || !c) return null; a.drawPoint(c, _annProps(p, 'point')); return '📌 Point'; },
      draw_line:   function (p) { var a = _api(), cs = (p.coordinates || []).map(_coordsOf).filter(Boolean); if (!a || cs.length < 2) return null; a.drawPolyline(cs, _annProps(p, 'polyline')); return '➖ Line'; },
      draw_polygon:function (p) { var a = _api(), cs = (p.coordinates || []).map(_coordsOf).filter(Boolean); if (!a || cs.length < 3) return null; a.drawPolygon(cs, _annProps(p, 'polygon')); return '⬠ Polygon'; },
      draw_circle: function (p) { var a = _api(), c = _coordsOf(p); if (!a || !c || !p.radius_ft) return null; a.drawCircle(c, p.radius_ft, _annProps(p, 'circle')); return '⭕ ' + _fmtFt(p.radius_ft) + ' circle'; },
      label_point: function (p) { var a = _api(), c = _coordsOf(p); if (!a || !c || !p.text) return null; a.addLabel(c, p.text); return '🏷️ Label'; },
      label_parcel_centroid: function (p) { var a = _api(), c = _parcelCentroid(_resolveParcel(p.pin)); if (!a || !c || !p.text) return null; a.addLabel(c, p.text); return '🏷️ Labeled parcel'; },
      draw_parcel_buffer: function (p) {
        var a = _api(), t = _turf(), f = _resolveParcel(p.pin);
        if (!a || !t || !f || !p.distance_ft) return null;
        var buffered;
        try { buffered = t.buffer(f, _ft2mi(p.distance_ft) * (p.inward ? -1 : 1), { units: 'miles' }); }
        catch (e) { return null; }
        if (!buffered || !buffered.geometry) return null;
        var ring = buffered.geometry.coordinates[0].map(function (c) { return [c[0], c[1]]; });
        a.drawPolygon(ring, {
          featureType: 'polygon', labelAuto: true,
          label: p.label || (_fmtFt(p.distance_ft) + (p.inward ? ' setback' : ' buffer')),
          style: { strokeColor: '#d97706', fillColor: '#f59e0b', fillOpacity: 0.15 },
        });
        return '⭕ ' + _fmtFt(p.distance_ft) + (p.inward ? ' setback' : ' buffer');
      },
      place_structure_in_parcel: function (p) {
        var a = _api(), c = _parcelCentroid(_resolveParcel(p.pin));
        if (!a || !c || !p.width_ft || !p.depth_ft) return null;
        a.placeStructure({ center: c, width: p.width_ft, depth: p.depth_ft, units: 'feet', rotationDeg: p.rotation_deg || 0, label: p.label || 'Structure' });
        return '🏠 ' + p.width_ft + '×' + p.depth_ft + ' ft footprint';
      },
      clear_annotations: function () { var a = _api(); if (a) a.clearAnnotations(); return '🧹 Cleared drawings'; },

      // ── Built-in map tools (the viewer's own tooling) ─────────────────────────
      set_parcel_labels: function (p) {
        var L = root.PS_PARCEL_LABELS; if (!L) return null;
        var visible = p.visible !== false;
        if (p.field && L.setField) L.setField(p.field);
        if (p.size && L.setSize) L.setSize(p.size);
        if (visible) { if (L.activate) L.activate(); } else { if (L.deactivate) L.deactivate(); return '🏷️ Labels off'; }
        var nice = { owner:'Owner', pin:'PIN', address:'Address', av:'Assessed value', sev:'SEV',
                     tv:'Taxable value', tmv:'Market value', tmv_acre:'$/acre', zoning:'Zoning', class:'Class' };
        return '🏷️ ' + (nice[p.field] || 'Parcel') + ' labels on';
      },
      dimension_parcel: function (p) {
        var f = _resolveParcel(p.pin);
        if (!f || !root.PS_MEASURE_TOOL || !root.PS_MEASURE_TOOL.dimensionParcel) return null;
        root.PS_MEASURE_TOOL.dimensionParcel(f);
        return '📐 Dimensioned the parcel';
      },
      activate_draw_tool: function (p) {
        var D = root.PS_DRAWING_TOOLS; if (!D || !p.tool || !D.setActiveDrawTool) return null;
        if (D.setStyle && (p.color || p.fill_color)) {
          var st = {}; if (p.color) st.strokeColor = p.color; if (p.fill_color) st.fillColor = p.fill_color;
          D.setStyle(st);
        }
        // Open the Draw tab first, the same way a user gets there: its tool buttons show the
        // active tool (click it again to stop), and leaving the tab exits drawing. Without
        // it the map sat in draw mode with panning and parcel clicks disabled and nothing on
        // screen to turn it off.
        if (root.PS_MAP_PANEL && root.PS_MAP_PANEL.setTab) {
          root.PS_MAP_PANEL.setTab('draw');
          var panel = document.getElementById('map-control-panel'); if (panel) panel.hidden = false;
          if (root.PV_MOBILE_TABS && root.PV_MOBILE_TABS.refresh) root.PV_MOBILE_TABS.refresh();
        }
        D.setActiveDrawTool(p.tool);
        return '✏️ ' + p.tool + ' tool — draw on the map (Esc when done)';
      },
      undo: function () { if (root.PS_UNDO_REDO && root.PS_UNDO_REDO.undo) { root.PS_UNDO_REDO.undo(); return '↩️ Undo'; } return null; },
      redo: function () { if (root.PS_UNDO_REDO && root.PS_UNDO_REDO.redo) { root.PS_UNDO_REDO.redo(); return '↪️ Redo'; } return null; },

      // Open one of the viewer's own tools/windows (Parcel Packet, Compare, Street
      // View, tax/assessment explainers, print, share, bookmark, settings, …).
      open_tool: function (p) {
        var T = root.PV_TOOLS; if (!T || !T.open) return null;
        var name = String(p.tool || p.name || '').toLowerCase().replace(/_/g, '-').trim();
        var ALIAS = {
          'parcel-packet': 'packet', 'report': 'packet',
          'compare-parcels': 'compare', 'street-view': 'streetview',
          'tax-description': 'tax', 'taxes': 'tax', 'assessment': 'assess',
          'bookmarks': 'bookmark',
        };
        var canon = ALIAS[name] || name;
        T.open(canon);
        var LABEL = { packet: 'Parcel Packet', compare: 'Compare Parcels', streetview: 'Street View',
          tax: 'Tax Explainer', assess: 'Assessment Explainer', print: 'Print', share: 'Share',
          bookmark: 'Bookmarks', 'data-request': 'Data Request', 'report-error': 'Report Error',
          help: 'Help', 'whats-new': "What's New", about: 'About', settings: 'Settings' };
        return '🪟 Opened ' + (LABEL[canon] || canon);
      },

      // ── Compare (DIC-589): open the side-by-side table for named parcels ──────
      compare_parcels: function (p) {
        if (!root.PV_COMPARE || !root.PV_COMPARE.open) return null;
        var items = [].concat(p.ids || [], p.pins || []).filter(function (x) { return x != null && x !== ''; });
        if (items.length < 2) return null;
        root.PV_COMPARE.open(items.slice(0, 5));
        return '📊 Compared ' + Math.min(items.length, 5) + ' parcels';
      },

      // ── Neighborhood / Area Profile (DIC-588): open the dashboard + AI character read ──
      describe_neighborhood: function (p) {
        if (!root.PV_PROFILE || !root.PV_PROFILE.open) return null;
        var geo = p.geography && String(p.geography).toLowerCase();
        if (geo && ['subdivision', 'section', 'township', 'school'].indexOf(geo) >= 0) {
          var name = p.name != null ? String(p.name) : null;
          if (!name) return null;
          root.PV_PROFILE.open({ mode: geo, geoName: name });
          return '🏘️ Profiling ' + name;
        }
        var opts = { mode: 'buffer' };
        if (p.id != null && !isNaN(parseInt(p.id, 10))) opts.parcelId = parseInt(p.id, 10);
        if (p.distance_ft != null && !isNaN(Number(p.distance_ft))) opts.distanceFt = Number(p.distance_ft);
        root.PV_PROFILE.open(opts);   // parcelId omitted → defaults to the selected parcel
        var d = opts.distanceFt || 1320;
        return '🏘️ Neighborhood profile (' + (d >= 5280 ? (d / 5280) + ' mi' : d + ' ft') + ')';
      },

      // ── Interface / appearance ────────────────────────────────────────────────
      set_theme: function (p) {
        var dark = p.dark != null ? !!p.dark : /dark|night/i.test(p.mode || p.theme || '');
        if (root.PV_THEME && root.PV_THEME.set) { root.PV_THEME.set(dark); return dark ? '🌙 Dark mode' : '☀️ Light mode'; }
        return null;
      },
      set_basemap: function (p) {
        var b = String(p.basemap || '').toLowerCase();
        if (['light', 'dark', 'aerial'].indexOf(b) < 0) return null;
        if (root.PV_PREFS && root.PV_PREFS.setBasemap) { root.PV_PREFS.setBasemap(b); return '🗺️ ' + b.charAt(0).toUpperCase() + b.slice(1) + ' basemap'; }
        return null;
      },
      set_base_layer: function (p) {
        var L = root.PS_MAP_PANEL && root.PS_MAP_PANEL.layers; if (!L) return null;
        var did = [];
        if (typeof p.aerial === 'boolean' && L.setAerial) { L.setAerial(p.aerial); did.push('aerial ' + (p.aerial ? 'on' : 'off')); }
        if (typeof p.parcels === 'boolean' && L.setZoning) { L.setZoning(p.parcels); did.push('parcels ' + (p.parcels ? 'on' : 'off')); }
        return did.length ? '🗺️ ' + did.join(', ') : null;
      },
      set_accessibility: function (p) {
        var A = root.PV_A11Y; if (!A) return null;
        if (p.max != null && A.setMax) { A.setMax(!!p.max); return p.max ? '♿ Max accessibility on' : '♿ Accessibility reset'; }
        var did = [];
        if (p.large_text != null && A.setTextScale) { A.setTextScale(p.large_text ? 1.3 : 1); did.push('text ' + (p.large_text ? 'large' : 'normal')); }
        if (p.text_scale != null && A.setTextScale) { A.setTextScale(p.text_scale); did.push('text ' + p.text_scale + '×'); }
        if (p.high_contrast != null && A.setFlag) { A.setFlag('contrast', !!p.high_contrast); did.push('contrast ' + (p.high_contrast ? 'on' : 'off')); }
        if (p.readable_font != null && A.setFlag) { A.setFlag('font', !!p.readable_font); did.push('readable font ' + (p.readable_font ? 'on' : 'off')); }
        if (p.reduce_motion != null && A.setFlag) { A.setFlag('motion', !!p.reduce_motion); did.push('reduced motion ' + (p.reduce_motion ? 'on' : 'off')); }
        if (p.reduce_transparency != null && A.setFlag) { A.setFlag('solid', !!p.reduce_transparency); did.push('solid panels ' + (p.reduce_transparency ? 'on' : 'off')); }
        return did.length ? '♿ ' + did.join(', ') : null;
      },
      set_panel_transparency: function (p) {
        if (root.PV_GLASS && p.alpha != null) { var a = root.PV_GLASS.set(p.alpha); return '🪟 Panels ' + Math.round(a * 100) + '% opaque'; }
        return null;
      },
      open_panel: function (p) {
        var which = String(p.panel || '').toLowerCase();
        if (/buddy|assistant|chat/.test(which)) return '💬 MapBuddy';
        if (root.PS_MAP_PANEL) {
          if (p.tab && root.PS_MAP_PANEL.setTab) root.PS_MAP_PANEL.setTab(p.tab);
          var el = document.getElementById('map-control-panel'); if (el) el.hidden = false;
          if (root.PV_MOBILE_TABS && root.PV_MOBILE_TABS.refresh) root.PV_MOBILE_TABS.refresh();
          return '📋 Opened ' + (p.tab || 'controls') + ' panel';
        }
        return null;
      },
      set_area_units: function (p) {
        var u = /sq|ft|feet/i.test(p.units || '') ? 'sqft' : 'acres';
        if (root.PV_PREFS && root.PV_PREFS.setAreaUnits) { root.PV_PREFS.setAreaUnits(u); return '📏 ' + (u === 'sqft' ? 'Square feet' : 'Acres'); }
        return null;
      },
      set_coordinate_format: function (p) {
        var m = { dd: 'dd', decimal: 'dd', dms: 'dms', spc: 'spc', 'state plane': 'spc', stateplane: 'spc' };
        var fmt = m[String(p.format || '').toLowerCase()];
        if (fmt && root.PV_COORDS && root.PV_COORDS.setFormat) { root.PV_COORDS.setFormat(fmt); return '🧭 ' + fmt.toUpperCase() + ' coordinates'; }
        return null;
      },
      bookmark_current: function () {
        var p = _parcel();
        if (p && p.id != null && root.PV_BOOKMARKS && root.PV_BOOKMARKS.add) { root.PV_BOOKMARKS.add(p); return '⭐ Bookmarked ' + (p.pin || ''); }
        return null;
      },

      // ── Measurement (append an info bubble — model can't see the result) ───────
      measure_parcel: function (p) {
        var a = _api(), f = _resolveParcel(p.pin); if (!a || !f) return null;
        var pin = f.properties.pin || f.properties.PIN, info = a.quickParcelInfo(pin);
        ui.info('<strong>Parcel ' + _escHtml(pin) + '</strong><br>' +
          info.acres + ' ac · ' + info.sqft.toLocaleString() + ' ft²<br>' +
          'Perimeter ' + info.perimFt.toLocaleString() + ' ft · ~' + info.estDimLong + '×' + info.estDimShort + ' ft');
        return '📐 Measured ' + pin;
      },
      measure_area: function (p) {
        var a = _api(), cs = (p.coordinates || []).map(_coordsOf).filter(Boolean);
        if (!a || cs.length < 3) return null;
        var r = a.measureArea(cs);
        ui.info('<strong>Area</strong><br>' + r.acres + ' ac · ' + r.sqft.toLocaleString() + ' ft²<br>Perimeter ' + r.perimFt.toLocaleString() + ' ft');
        return '📐 Measured area';
      },
      measure_distance: function (p) {
        var a = _api(), cs = (p.coordinates || []).map(_coordsOf).filter(Boolean);
        if (!a || cs.length < 2) return null;
        var r = a.measureDistance(cs);
        ui.info('<strong>Distance</strong><br>' + r.totalFt.toLocaleString() + ' ft (' + (r.totalFt / 5280).toFixed(2) + ' mi)');
        return '📐 Measured distance';
      },

      // ── Search (resolve client-side against the loaded parcel index) ──────────
      search_parcels: function (p) {
        var q = (p.query || '').toLowerCase().trim(); if (!q) return null;
        var idx = root.PS_PARCEL_INDEX || [], hits = [];
        for (var i = 0; i < idx.length && hits.length < 25; i++) {
          var pr = idx[i].properties || {};
          var hay = [pr.pin || pr.PIN, pr.owner_name || pr.OWNER_NAME, pr.site_address || pr.SITE_ADDRESS].join(' ').toLowerCase();
          if (hay.indexOf(q) !== -1) hits.push(idx[i]);
        }
        if (!hits.length) { ui.info('No parcels matched “' + _escHtml(p.query) + '”.'); return 'No matches'; }
        if (hits.length === 1) {
          var pin = hits[0].properties.pin || hits[0].properties.PIN;
          if (root.PS_selectParcel) root.PS_selectParcel(pin);
          _CMDS.cinematic_fly_to_parcel({ pin: pin });
          return '🔎 Found ' + pin;
        }
        var html = '<strong>' + hits.length + ' matches</strong> for “' + _escHtml(p.query) + '”:<ul class="mb-result-list">';
        for (var j = 0; j < hits.length; j++) {
          var pr2 = hits[j].properties, pin2 = pr2.pin || pr2.PIN;
          html += '<li><button class="mb-result-btn" data-pin="' + _escHtml(pin2) + '">' +
            _escHtml(pin2) + (pr2.owner_name ? ' — ' + _escHtml(pr2.owner_name) : '') + '</button></li>';
        }
        ui.results(html + '</ul>');
        return '🔎 ' + hits.length + ' matches';
      },

      // ── Proactive offers — render tappable "next step" suggestions ────────────
      suggest_actions: function (p) { ui.suggest(p.suggestions || p.actions || []); return null; },

      // ── Map vision (DIC-2135): the server already enforces one offer and one look ──
      look_at_map: function (p) {
        ui.requestLook((p && p.question) ? String(p.question).slice(0, 500) : null);
        return '👁️ Looking at the map';
      },
      offer_map_look: function (p) {
        // The panel shows at most one offer per conversation.
        ui.offerLook(p && p.question ? String(p.question).slice(0, 500) : null);
        return null;
      },

      // ── Showcase: a guided fly-through tour ───────────────────────────────────
      map_tour: function (p) {
        var stops = p.stops || [], m = _map(); if (!m || !stops.length) return null;
        var i = 0;
        (function step() {
          if (i >= stops.length) return;
          var s = stops[i++], c = _coordsOf(s) || _parcelCentroid(_resolveParcel(s.pin));
          if (c) m.flyTo({ center: c, zoom: s.zoom || 16, speed: 0.8, curve: 1.4, essential: true });
          if (s.note) ui.info(_escHtml(s.note));
          setTimeout(step, 2600);
        })();
        return '🎬 Tour · ' + stops.length + ' stops';
      },
    };

    function _runCommands(cmds) {
      var chips = [];
      _cam = null;
      _cancelCinematic();  // a new request stops any in-flight fly-around
      for (var i = 0; i < cmds.length; i++) {
        var cmd = cmds[i]; if (!cmd || !cmd.type) continue;
        // Own properties only: names like "constructor" must not resolve to prototype methods.
        var fn = Object.prototype.hasOwnProperty.call(_CMDS, cmd.type) ? _CMDS[cmd.type] : null;
        if (!fn) { console.warn('[Map Buddy] unknown command:', cmd.type); continue; }
        try { var label = fn(cmd.payload || {}); if (label) chips.push(label); }
        catch (e) { console.warn('[Map Buddy] command error', cmd, e); }
      }
      _flushCamera();
      return chips;
    }

    // Snapshot of the live map view + visible overlays, sent as context so the AI
    // knows where the user is looking and can pass real coordinates back.
    function _buildMapState() {
      var m = _map(); if (!m) return null;
      var c = m.getCenter(), layers = [];
      try {
        if (root.PS_OVERLAY_LAYERS && root.PS_OVERLAY_LAYERS.getState) {
          var st = root.PS_OVERLAY_LAYERS.getState() || {};
          for (var id in st) { if (st[id]) layers.push(_LAYER_LABEL[id] || id); }
        }
        if (root.PS_COUNTY_LAYERS && root.PS_COUNTY_LAYERS.getState) {
          var cst = root.PS_COUNTY_LAYERS.getState() || {};
          for (var cid in cst) { if (cst[cid]) layers.push(_LAYER_LABEL[cid] || cid); }
        }
      } catch (e) {}
      // Full live layer state (DIC-327): every layer + visibility + field schema,
      // so the AI knows what's on the map and what each layer contains. Falls back
      // to the legacy visible-overlay labels if the registry isn't loaded.
      var registry = null;
      try {
        if (root.PS_LAYER_REGISTRY && root.PS_LAYER_REGISTRY.snapshot) {
          registry = root.PS_LAYER_REGISTRY.snapshot();
        }
      } catch (e) {}
      return {
        center:  [ +c.lng.toFixed(6), +c.lat.toFixed(6) ],
        zoom:    +m.getZoom().toFixed(2),
        bearing: Math.round(m.getBearing()),
        pitch:   Math.round(m.getPitch()),
        visible_layers: layers,
        layers:  registry,
      };
    }

    // A search result the user picked: select it and fly there.
    function selectResult(pin) {
      if (root.PS_selectParcel) root.PS_selectParcel(pin);
      _CMDS.cinematic_fly_to_parcel({ pin: pin });
    }

    return { run: _runCommands, buildMapState: _buildMapState, cancelCinematic: _cancelCinematic, selectResult: selectResult };
  }

  root.PV_MAP_BUDDY_COMMANDS = { create: create };
})(window);
