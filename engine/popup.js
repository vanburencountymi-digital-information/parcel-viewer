/**
 * popup.js — source-agnostic popup-section renderer (A5 / DIC-407).
 *
 * Renders "a source's popup.sections over a feature's fields" with NO knowledge of any
 * one domain (§4.1). Returns STRUCTURED data (sections → rows), never inline HTML
 * (§6.1) — the DOM/print layer formats it, so the same renderer feeds the info panel
 * AND print/export.
 *
 * Two section shapes are supported:
 *   - string                      → legacy: one row, field = the lowercased name.
 *   - { title, fields: [...] }     → rich: each field is { label, field, format?, labelMap? }.
 *
 * Formatters (by name, extensible via opts.formatters): money, acres, label
 * (code → name via opts.labels[labelMap]), code-label ("401 – Residential"), text.
 *
 * renderSections(source, feature, opts?) -> [{ section, rows }]
 *   opts = { labels?, formatters? }
 *
 * UMD: Node module (harness) + browser global (window.ISV_POPUP).
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_POPUP = mod;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function num(v) { if (v == null || v === '') return null; var n = Number(v); return isNaN(n) ? null : n; }

  var FORMATTERS = {
    text: function (v) { return v == null || v === '' ? null : String(v); },
    money: function (v) { var n = num(v); return n == null ? null : '$' + Math.round(n).toLocaleString('en-US'); },
    acres: function (v) { var n = num(v); return n == null ? null : n.toFixed(2) + ' ac'; },
    label: function (v, ctx) {
      if (v == null || v === '') return null;
      var m = ctx.labels && ctx.labelMap && ctx.labels[ctx.labelMap];
      return (m && m[String(v).trim()]) || String(v);
    },
    'code-label': function (v, ctx) {
      if (v == null || v === '') return null;
      var code = String(v).trim();
      var m = ctx.labels && ctx.labelMap && ctx.labels[ctx.labelMap];
      var name = m && m[code];
      return name ? (code + ' – ' + name) : code;
    },
  };

  function renderSections(source, feature, opts) {
    opts = opts || {};
    var props = (feature && feature.properties) || feature || {};
    var labels = opts.labels || null;
    var formatters = opts.formatters || {};
    var sections = (source && source.popup && source.popup.sections) || [];
    var fieldMap = (source && source.popup && source.popup.sectionFields) || null;

    function fmt(name, value, field) {
      var fn = formatters[name] || FORMATTERS[name] || FORMATTERS.text;
      // ctx carries labels + the WHOLE feature so a formatter can derive from sibling
      // fields (e.g. a mailing address built from street/city/state/zip).
      return fn(value, { labels: labels, labelMap: field.labelMap, props: props, field: field });
    }

    return sections.map(function (sec) {
      // Legacy string section → one row keyed by the lowercased section name.
      if (typeof sec === 'string') {
        var fields = (fieldMap && fieldMap[sec]) ? fieldMap[sec] : [sec.toLowerCase().replace(/\s+/g, '_')];
        return {
          section: sec,
          rows: fields.map(function (f) { return { field: f, value: props[f] != null ? props[f] : null }; }),
        };
      }
      // Rich section → { title, fields:[{label, field, format, labelMap, tip?, style?}] }.
      var rows = (sec.fields || []).map(function (f) {
        var raw = props[f.field];
        var row = { label: f.label || f.field, field: f.field, raw: raw != null ? raw : null, value: fmt(f.format || 'text', raw, f) };
        if (f.tip) row.tip = f.tip;       // optional viewer tooltip (added only when present,
        if (f.style) row.style = f.style; // so unconfigured rows keep their lean shape)
        return row;
      });
      return { section: sec.title || '', rows: rows };
    });
  }

  return { renderSections: renderSections, FORMATTERS: FORMATTERS };
}));
