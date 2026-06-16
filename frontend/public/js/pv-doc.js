/**
 * pv-doc.js — Per-parcel document export layer (DIC-372).
 *
 * Builds on PV_TEMPLATE to produce shareable/printable per-parcel documents:
 *   - capture the MapLibre canvas as a baked static image (map is created with
 *     preserveDrawingBuffer:true, so toDataURL works),
 *   - render a standalone HTML document from structured data + a template,
 *   - print (to PDF via the browser) or download a self-contained .html file.
 *
 * This is the shared plumbing the Parcel Packet and the Tax/Assessment
 * explainers (DIC-369/370) will reuse. Persistence (PIN+version) and stable
 * custom URLs are deferred — they need the writable-store backend (DIC-400/340).
 *
 * Exposes: window.PV_DOC
 */
(function (root) {
  'use strict';

  // ── Map image capture ──────────────────────────────────────────────────────
  function captureMapImage() {
    try {
      var map = root.PS_MAP;
      if (map && map.getCanvas) return map.getCanvas().toDataURL('image/png');
    } catch (e) { /* tainted canvas / no map */ }
    return null;
  }

  // ── Parcel summary document ────────────────────────────────────────────────
  var PARCEL_SUMMARY_TPL =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<title>Parcel {{pin}} — {{county}}</title><style>' +
    '*{box-sizing:border-box}' +
    'body{font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;margin:0;padding:24px;}' +
    '.doc{max-width:760px;margin:0 auto;}' +
    '.doc-head{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #A3473B;padding-bottom:8px;margin-bottom:16px;}' +
    '.doc-brand{font-weight:700;font-size:16px;color:#A3473B;}' +
    '.doc-sub{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;}' +
    '.doc-map{width:100%;height:auto;border:1px solid #d1d5db;border-radius:6px;margin-bottom:16px;}' +
    '.doc-pin{font-size:22px;margin:0 0 2px;}' +
    '.doc-owner{margin:0 0 16px;color:#4b5563;font-size:15px;}' +
    '.doc-table{width:100%;border-collapse:collapse;font-size:14px;}' +
    '.doc-table th{text-align:left;width:34%;padding:7px 10px;color:#6b7280;font-weight:600;vertical-align:top;border-bottom:1px solid #eee;}' +
    '.doc-table td{padding:7px 10px;border-bottom:1px solid #eee;}' +
    '.doc-foot{margin-top:20px;font-size:11px;color:#9ca3af;}' +
    '@media print{body{padding:0;}.doc{max-width:none;}a{color:inherit;text-decoration:none;}}' +
    '</style></head><body><div class="doc">' +
    '<header class="doc-head"><span class="doc-brand">{{county}}</span><span class="doc-sub">Parcel Summary</span></header>' +
    '{{#mapImage}}<img class="doc-map" src="{{mapImage}}" alt="Map of parcel {{pin}}">{{/mapImage}}' +
    '<h1 class="doc-pin">Parcel {{pin}}</h1>' +
    '{{#owner}}<p class="doc-owner">{{owner}}</p>{{/owner}}' +
    '<table class="doc-table">{{#rows}}<tr><th>{{label}}</th><td>{{value}}</td></tr>{{/rows}}</table>' +
    '<footer class="doc-foot">Generated {{generated}} · {{county}} Parcel Viewer</footer>' +
    '</div></body></html>';

  function _today() {
    try { return new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); }
    catch (e) { return ''; }
  }

  function _fmtAcres(a) {
    if (a == null || a === '') return null;
    var n = parseFloat(a);
    return isNaN(n) ? null : n.toFixed(2) + ' acres';
  }

  // Map a parcel record (PS_STATE.parcel or a full API record) → template data.
  function parcelSummaryData(parcel, opts) {
    opts = opts || {};
    var p = parcel || {};
    var county = (root.COUNTY && root.COUNTY.name) || 'County';
    var rows = [];
    function row(label, value) { if (value != null && value !== '') rows.push({ label: label, value: value }); }
    row('Owner', p.owner_name || p.owner);
    row('Address', p.site_address || p.address);
    row('Municipality', p.municipality);
    row('Area', _fmtAcres(p.acres != null ? p.acres : p.gis_acres));
    if (Array.isArray(opts.rows)) opts.rows.forEach(function (r) { row(r.label, r.value); });
    return {
      county: county,
      pin: p.pin || p.parcel_no || '',
      owner: p.owner_name || p.owner || '',
      rows: rows,
      mapImage: opts.mapImage || null,
      generated: opts.date || _today(),
    };
  }

  function parcelSummaryHtml(parcel, opts) {
    if (!root.PV_TEMPLATE) return '';
    return root.PV_TEMPLATE.render(PARCEL_SUMMARY_TPL, parcelSummaryData(parcel, opts));
  }

  // ── Output ────────────────────────────────────────────────────────────────
  function print(html) {
    var f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(f);
    var d = f.contentWindow.document;
    d.open(); d.write(html); d.close();
    setTimeout(function () {
      try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) {}
      setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 1000);
    }, 300);  // let the baked map image paint before printing
  }

  function downloadHtml(html, filename) {
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename || 'document.html';
    document.body.appendChild(a); a.click();
    setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  function _pinFor(parcel) {
    var pin = (parcel && (parcel.pin || parcel.parcel_no)) || 'parcel';
    return String(pin).replace(/[^\w.-]/g, '_');
  }

  function printParcelSummary(parcel, opts) {
    opts = opts || {};
    if (opts.mapImage === undefined) opts.mapImage = captureMapImage();
    print(parcelSummaryHtml(parcel, opts));
  }

  function downloadParcelSummary(parcel, opts) {
    opts = opts || {};
    if (opts.mapImage === undefined) opts.mapImage = captureMapImage();
    downloadHtml(parcelSummaryHtml(parcel, opts), 'parcel-' + _pinFor(parcel) + '.html');
  }

  root.PV_DOC = {
    captureMapImage: captureMapImage,
    parcelSummaryData: parcelSummaryData,
    parcelSummaryHtml: parcelSummaryHtml,
    print: print,
    downloadHtml: downloadHtml,
    printParcelSummary: printParcelSummary,
    downloadParcelSummary: downloadParcelSummary,
    PARCEL_SUMMARY_TPL: PARCEL_SUMMARY_TPL,
  };
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this)));
