/**
 * popup.js — source-agnostic popup-section renderer (A2 engine-smoke stub; seeds A5).
 *
 * Proves the §4.1 direction: the engine renders "a source's popup.sections over a
 * feature's fields" with NO knowledge of any one domain. Returns STRUCTURED data
 * (rows), not inline HTML (§6.1) — the DOM layer formats it.
 *
 * PROVISIONAL: a stub to anchor the engine smoke test, NOT the A5/DIC-407 source
 * abstraction. A5 replaces the domain-specific showXInfo(id) callers with a real
 * showFeatureInfo(source, id) built on this idea.
 *
 * renderSections(source, feature) -> [{ section, rows: [{ field, value }] }]
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

  // Map a manifest popup-section name to the feature fields it shows. In v1 a source
  // may carry a `sectionFields` map; absent that, each section renders the field that
  // matches its lowercased name (good enough for the smoke test).
  function renderSections(source, feature) {
    source = source || {};
    var props = (feature && feature.properties) || {};
    var sections = (source.popup && source.popup.sections) || [];
    var fieldMap = (source.popup && source.popup.sectionFields) || null;

    return sections.map(function (sectionName) {
      var fields = fieldMap && fieldMap[sectionName]
        ? fieldMap[sectionName]
        : [sectionName.toLowerCase().replace(/\s+/g, '_')];
      var rows = fields.map(function (f) {
        return { field: f, value: props[f] != null ? props[f] : null };
      });
      return { section: sectionName, rows: rows };
    });
  }

  return { renderSections: renderSections };
}));
