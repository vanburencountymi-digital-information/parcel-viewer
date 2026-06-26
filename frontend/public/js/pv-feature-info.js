/**
 * pv-feature-info.js — generic, source-agnostic feature info panel (A5 / DIC-407).
 *
 * The viewer-side `showFeatureInfo(source, feature)`: it turns the engine's STRUCTURED
 * sections (ISV_POPUP.renderSections over a source's popup.sections) into info-panel
 * HTML and shows it in the existing panel. The same renderer that drives parcels drives
 * ANY source — zoning, roads, address points — with no per-source code. A source with no
 * declared popup.sections falls back to an auto "Details" section built from the
 * feature's own fields, so any layer is clickable-to-info with zero config.
 *
 * This is the engine seam reaching the live panel. The rich parcel panel (showParcelInfo
 * in map.js, with its AV chart + action buttons) is unchanged; this is additive and used
 * for non-parcel sources (and as the migration target for the parcel panel's field
 * sections). Vector source click wiring lives in wms-feature-info.js so click
 * precedence stays close to the overlay identify path.
 *
 * Exposes: window.PV_FEATURE_INFO { renderHtml, show, select, autoConfig }
 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function countyConfig() {
    return (root.PS_CONTEXT && root.PS_CONTEXT.config) || root.COUNTY || {};
  }

  function rowsHtml(rows) {
    return rows.map(function (r) {
      if (r.value == null || r.value === '') return '';
      return '<div class="parcel-info-row"><span class="parcel-info-label">' + esc(r.label || r.field) +
        '</span><span class="parcel-info-value">' + esc(r.value) + '</span></div>';
    }).join('');
  }

  function sectionHtml(sec) {
    var body = rowsHtml(sec.rows);
    if (!body) return '';
    var head = sec.section ? '<div class="parcel-info-section-title">' + esc(sec.section) + '</div>' : '';
    return '<div class="parcel-info-section">' + head + body + '</div>';
  }

  // Build an ad-hoc "Details" source config from a feature's own scalar fields — so any
  // source renders even without a declared popup. (Skips object/geometry fields.)
  function autoConfig(feature) {
    var props = (feature && feature.properties) || feature || {};
    var fields = Object.keys(props)
      .filter(function (k) { return k !== 'geometry' && typeof props[k] !== 'object' && typeof props[k] !== 'function'; })
      .map(function (k) { return { label: k, field: k }; });
    return { id: 'feature', idField: 'id', popup: { sections: [{ title: 'Details', fields: fields }] } };
  }

  function renderHtml(sourceConfig, feature, labels) {
    if (!root.ISV_POPUP) return '';
    var cfg = (sourceConfig && sourceConfig.popup && sourceConfig.popup.sections) ? sourceConfig : autoConfig(feature);
    var sections = root.ISV_POPUP.renderSections(cfg, feature, { labels: labels });
    var html = sections.map(sectionHtml).join('');
    return html || '<div class="parcel-info-row"><span class="parcel-info-value">No details.</span></div>';
  }

  function featureId(sourceConfig, feature) {
    var props = (feature && feature.properties) || feature || {};
    var idField = sourceConfig && sourceConfig.idField;
    if (idField && props[idField] != null) return props[idField];
    if (feature && feature.id != null) return feature.id;
    return props.id != null ? props.id : null;
  }

  // Render a source's feature into the shared info panel. opts.title sets the header,
  // opts.labels overrides the label maps (defaults to COUNTY.labels).
  function show(sourceConfig, feature, opts) {
    opts = opts || {};
    var panel = document.getElementById('parcel-info-panel');
    var body = panel && panel.querySelector('.parcel-info-body');
    if (!panel || !body) return false;
    body.innerHTML = renderHtml(sourceConfig, feature, opts.labels || countyConfig().labels);
    var titleEl = panel.querySelector('.parcel-info-title');
    if (titleEl && opts.title != null) titleEl.textContent = opts.title;
    panel.hidden = false;
    return true;
  }

  function select(sourceConfig, feature, opts) {
    opts = opts || {};
    var ok = show(sourceConfig, feature, opts);
    if (!ok) return false;

    var ref = {
      sourceId: (sourceConfig && sourceConfig.id) || 'feature',
      id: featureId(sourceConfig, feature),
      properties: (feature && feature.properties) || feature || {},
      geometry: feature && feature.geometry ? feature.geometry : null,
    };

    if (root.PS_SELECTION) {
      root.PS_SELECTION.select(ref);
      if (typeof root.PS_SELECTION.setActive === 'function') root.PS_SELECTION.setActive(ref);
    } else if (root.PS_BUS) {
      root.PS_BUS.emit('selection-changed', { ref: ref, previous: null });
      root.PS_BUS.emit('active-feature-changed', { ref: ref, previous: null });
    }
    try {
      root.dispatchEvent(new CustomEvent('pv:feature-selected', { detail: { ref: ref, source: sourceConfig, feature: feature } }));
    } catch (_) {}
    return true;
  }

  root.PV_FEATURE_INFO = { renderHtml: renderHtml, show: show, select: select, autoConfig: autoConfig };
}(typeof window !== 'undefined' ? window : this));
