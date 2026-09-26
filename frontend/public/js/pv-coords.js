/**
 * pv-coords.js — the ONE set of coordinate formatters (DIC-1882).
 *
 * Used by the bottom-right cursor readout and the parcel card's "Center" row (map.js),
 * and by the map's right-click menu (pv-context-menu.js), so they never disagree.
 *
 *   PV_COORD_FMT.readout(lngLat, fmt)  display text for the readout ("dd" | "dms" | "spc")
 *   PV_COORD_FMT.copyRows(lngLat)      [{ id, label, text }] — each row's text is exactly
 *                                      what "copy" puts on the clipboard
 *
 * Michigan State Plane South (EPSG:6497, US survey feet) matches the Measurement tool.
 * It needs proj4 (loaded from the CDN); without it the State Plane forms are omitted.
 * Pure and DOM-free, so engine/test/coords.test.js can load it in node.
 */
(function (root) {
  'use strict';

  var MI_STATE_PLANE_DEF = '+proj=lcc +lat_0=41.5 +lon_0=-84.3666666666667 ' +
    '+lat_1=42.1 +lat_2=43.6667 +x_0=4000000 +y_0=0 +ellps=GRS80 +units=us-ft +no_defs';
  var WGS84_DEF = '+proj=longlat +datum=WGS84 +no_defs';
  var READOUT_FORMATS = ['dd', 'dms', 'spc'];

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function hemi(v, pos, neg) { return v >= 0 ? pos : neg; }

  // Degrees/minutes/seconds with the seconds rounded to `secDecimals`, carrying
  // 60 s → 1 min and 60 min → 1°, so 42.99999° never prints as 42°59'60".
  function dmsParts(v, secDecimals) {
    var scale = Math.pow(10, secDecimals);
    var totalSec = Math.round(Math.abs(v) * 3600 * scale) / scale;
    var d = Math.floor(totalSec / 3600);
    var rem = totalSec - d * 3600;
    var m = Math.floor(rem / 60 + 1e-9);
    var s = rem - m * 60;
    if (s < 0) s = 0;
    return { d: d, m: m, s: s };
  }
  function secText(s, decimals) {
    var t = s.toFixed(decimals);
    return (s < 10 ? '0' : '') + t;
  }

  // ── Readout forms (the bottom-right pill; unchanged from map.js) ────────────
  function ddReadout(v, pos, neg) { return Math.abs(v).toFixed(5) + '°' + hemi(v, pos, neg); }
  function dmsReadout(v, pos, neg) {
    var p = dmsParts(v, 0);
    return p.d + '°' + pad2(p.m) + "'" + pad2(Math.round(p.s)) + '"' + hemi(v, pos, neg);
  }

  function statePlane(lng, lat) {
    var proj4 = root.proj4;
    if (!proj4) return null;
    try {
      var xy = proj4(WGS84_DEF, MI_STATE_PLANE_DEF, [lng, lat]);
      if (!isFinite(xy[0]) || !isFinite(xy[1])) return null;
      return { e: xy[0], n: xy[1] };
    } catch (_) { return null; }
  }

  function readout(ll, fmt) {
    var lng = ll.lng, lat = ll.lat;
    if (fmt === 'dms') return dmsReadout(lat, 'N', 'S') + '  ' + dmsReadout(lng, 'E', 'W');
    if (fmt === 'spc') {
      var sp = statePlane(lng, lat);
      if (sp) return 'N ' + Math.round(sp.n).toLocaleString('en-US') + '  E ' + Math.round(sp.e).toLocaleString('en-US') + ' ft';
    }
    return ddReadout(lat, 'N', 'S') + '  ' + ddReadout(lng, 'E', 'W');
  }

  // ── Copy forms (the right-click menu) ───────────────────────────────────────
  // Plain ' and " marks (not ′ ″) so the text pastes into Google Maps, GPS units and
  // spreadsheets. Six decimals of a degree ≈ 0.1 m; 0.1" ≈ 3 m; 0.001' ≈ 2 m.
  function dmsCopy(v, pos, neg) {
    var p = dmsParts(v, 1);
    return p.d + '°' + pad2(p.m) + "'" + secText(p.s, 1) + '"' + hemi(v, pos, neg);
  }
  function ddmCopy(v, pos, neg) {
    var scale = 1000;
    var totalMin = Math.round(Math.abs(v) * 60 * scale) / scale;
    var d = Math.floor(totalMin / 60 + 1e-12);
    var m = totalMin - d * 60;
    if (m < 0) m = 0;
    return d + '°' + (m < 10 ? '0' : '') + m.toFixed(3) + "'" + hemi(v, pos, neg);
  }

  function copyRows(ll) {
    var lng = ll.lng, lat = ll.lat;
    if (!isFinite(lng) || !isFinite(lat)) return [];
    var rows = [
      { id: 'dd', label: 'Latitude, longitude', text: lat.toFixed(6) + ', ' + lng.toFixed(6) },
      { id: 'dms', label: 'Degrees, minutes, seconds', text: dmsCopy(lat, 'N', 'S') + ' ' + dmsCopy(lng, 'E', 'W') },
      { id: 'ddm', label: 'Degrees, decimal minutes', text: ddmCopy(lat, 'N', 'S') + ' ' + ddmCopy(lng, 'E', 'W') },
    ];
    var sp = statePlane(lng, lat);
    if (sp) {
      rows.push({ id: 'spc', label: 'MI State Plane South (US ft)',
        text: 'N ' + Math.round(sp.n) + ', E ' + Math.round(sp.e) });
    }
    rows.push({ id: 'lnglat', label: 'Longitude, latitude (GIS order)', text: lng.toFixed(6) + ', ' + lat.toFixed(6) });
    return rows;
  }

  root.PV_COORD_FMT = {
    readout: readout,
    copyRows: copyRows,
    readoutFormats: READOUT_FORMATS.slice(),
  };
})(typeof window !== 'undefined' ? window : globalThis);
