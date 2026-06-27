'use strict';
// manifest-assemble.js — the B2 manual-builder assembler (DIC-578). It maps the console's
// editor config slices into ONE §5 theme manifest; the acceptance is that the assembled
// manifest passes the SAME loadManifest() gate (migrate-on-load → validate) every consumer
// uses — i.e. the composer produces schema-valid output that round-trips.
const { test } = require('node:test');
const assert = require('node:assert');

const { assembleManifest } = require('../manifest-assemble.js');
const { loadManifest } = require('../load-manifest.js');
const CATALOG = require('../capability-catalog.js');

// A county-config shaped like frontend/public/js/county-config.js (the editor state).
function countyConfig() {
  return {
    name: 'Van Buren County',
    state: 'MI',
    map: { center: [-86.03, 42.24], zoom: 11, extent: [[-86.33, 42.06], [-85.76, 42.43]] },
    endpoints: { mapBuddy: 'https://map-buddy.example/api' },
    styling: {
      colorScheme: 'terracotta',
      schemes: [
        { id: 'terracotta', label: 'Terracotta', accent: '#A3473B', interactive: '#B58D4A' },
        { id: 'forest', label: 'Forest', accent: '#2F6B4F', interactive: '#4E9A6B' },
      ],
      layers: {
        subdivisions: { paint: { light: { fill: '#7A3B6B', stroke: '#553c5a' } }, labels: { enabled: true, field: 'name' } },
      },
    },
    // The Data & Layers editor stores arrays under `layers` (county-config.js shape).
    layers: {
      baseLayers: [
        { id: 'parcels', label: 'Parcels', source: 'County PostGIS', default: true,
          idField: 'pin', popup: { sections: ['Parcel', 'Owner', 'Assessed Values', 'Tax Description'] } },
        { id: 'aerial', label: 'Aerial imagery', type: 'raster', source: 'State imagery' },
      ],
      overlays: [
        { id: 'subdivisions', label: 'Subdivisions', type: 'vector', source: 'subdivisions_tiles', sourceLayer: 'subdivisions',
          geomType: 'polygon', minZoom: 12, default: false, outlineOnly: true, dbSource: 'geo.subdivisions', fields: ['name', 'unit'] },
        { id: 'wetlands', label: 'Wetlands', type: 'WMS', source: 'USFWS NWI', minZoom: 12 },
      ],
      countyOverlays: [
        { id: 'county-drains', label: 'Drains', martin: 'reference_drains_tiles', sourceLayer: 'reference_drains', geom: 'line', minzoom: 12 },
      ],
    },
    access: { model: 'Public — no sign-in' },
  };
}

test('assembled manifest passes loadManifest() — schema-valid, round-trips (the AC)', () => {
  const manifest = assembleManifest(countyConfig(), { tenant: 'vanburen', idFields: { parcels: 'pin' } });
  const res = loadManifest(manifest);
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
  assert.deepEqual(res.applied, []);   // already CURRENT_VERSION — assembler stamps it
});

test('branding/map/persona map across from the editor slices', () => {
  const manifest = assembleManifest(countyConfig(), { tenant: 'vanburen' });
  assert.equal(manifest.branding.name, 'Van Buren County');
  assert.equal(manifest.branding.theme['--ui-interactive'], '#B58D4A');   // active scheme
  assert.deepEqual(manifest.map.center, [-86.03, 42.24]);
  assert.equal(manifest.map.zoom, 11);
  assert.ok(Array.isArray(manifest.map.extent));
  assert.equal(manifest.persona.audience, 'public');   // from access.model
  assert.equal(manifest.mapBuddy.apiBase, 'https://map-buddy.example/api');
});

test('sources are collected from base layers + overlays, types normalized', () => {
  const manifest = assembleManifest(countyConfig(), { tenant: 'vanburen', idFields: { parcels: 'pin' } });
  const byId = Object.fromEntries(manifest.sources.map(s => [s.id, s]));
  assert.equal(byId.parcels.type, 'vector');
  assert.equal(byId.parcels.idField, 'pin');       // injected via opts.idFields
  assert.equal(byId.aerial.type, 'raster');
  assert.equal(byId.subdivisions.sourceLayer, 'subdivisions');
  assert.equal(byId.subdivisions.minZoom, 12);
  assert.equal(byId.wetlands.type, 'wms');          // 'WMS' → 'wms' (schema enum)
});

test('overlay sources carry the full layer config + per-layer style (Phase 3 B1)', () => {
  const manifest = assembleManifest(countyConfig(), { tenant: 'vanburen', idFields: { parcels: 'pin' } });
  const byId = Object.fromEntries(manifest.sources.map(s => [s.id, s]));
  const sub = byId.subdivisions;
  // generic layer-config keys carried verbatim so a renderer can drive the source
  assert.equal(sub.source, 'subdivisions_tiles');   // Martin tile-function name
  assert.equal(sub.geomType, 'polygon');
  assert.equal(sub.dbSource, 'geo.subdivisions');
  assert.deepEqual(sub.fields, ['name', 'unit']);
  assert.equal(sub.default, false);
  assert.equal(sub.outlineOnly, true);
  // base vs overlay role (lets the renderer pick the overlay set, excluding the parcel base)
  assert.equal(byId.parcels.role, 'base');
  assert.equal(byId.aerial.role, 'base');
  assert.equal(sub.role, 'overlay');
  assert.equal(byId.wetlands.role, 'overlay');
  // per-layer styling (styling.layers[id]) attached as `style`
  assert.equal(sub.style.paint.light.fill, '#7A3B6B');
  assert.equal(sub.style.labels.field, 'name');
  // still schema-valid with the grown shape
  assert.equal(loadManifest(manifest).ok, true);
});

test('county PostGIS overlays are collected with role county-overlay + legacy keys (Phase 3 C)', () => {
  const manifest = assembleManifest(countyConfig(), { tenant: 'vanburen' });
  const byId = Object.fromEntries(manifest.sources.map(s => [s.id, s]));
  const drains = byId['county-drains'];
  assert.equal(drains.role, 'county-overlay');
  assert.equal(drains.martin, 'reference_drains_tiles');   // tile-function name (legacy key)
  assert.equal(drains.geom, 'line');                       // legacy geometry key
  assert.equal(drains.minzoom, 12);                        // legacy lowercase minzoom preserved
  assert.equal(drains.sourceLayer, 'reference_drains');
  // distinct from the role 'overlay' set (so renderers don't conflate them)
  assert.equal(byId.subdivisions.role, 'overlay');
  assert.equal(loadManifest(manifest).ok, true);
});

test('parcel source carries the §5 popup section-name list + entry idField (Phase 3 D7)', () => {
  const manifest = assembleManifest(countyConfig(), { tenant: 'vanburen' });   // no opts.idFields
  const parcels = manifest.sources.find(s => s.id === 'parcels');
  assert.deepEqual(parcels.popup.sections, ['Parcel', 'Owner', 'Assessed Values', 'Tax Description']);
  assert.equal(parcels.idField, 'pin');   // idField declared on the entry (not via opts)
  assert.equal(loadManifest(manifest).ok, true);   // string-array sections are §5-valid
});

test('capabilities default to the catalog with per-capability AI tri-state', () => {
  const manifest = assembleManifest(countyConfig(), { tenant: 'vanburen' });
  assert.equal(manifest.capabilities.search.ai, 'no-ai');
  assert.equal(manifest.capabilities.explainer.ai, 'ai-optional');
  // Every enabled capability carries a tri-state the validator accepts.
  Object.values(manifest.capabilities).forEach(c => {
    assert.ok(['no-ai', 'ai-optional', 'ai-required'].includes(c.ai));
  });
});

test('capability selection + overrides are honored', () => {
  const manifest = assembleManifest(countyConfig(), {
    tenant: 'vanburen',
    capabilityIds: ['search', 'explainer'],
    capabilityOverrides: { explainer: { ai: 'ai-required' } },
  });
  assert.deepEqual(Object.keys(manifest.capabilities).sort(), ['explainer', 'search']);
  assert.equal(manifest.capabilities.explainer.ai, 'ai-required');   // override applied
  assert.equal(loadManifest(manifest).ok, true);
});

test('`data` is accepted as an alias for the `layers` block', () => {
  const cfg = countyConfig();
  cfg.data = cfg.layers; delete cfg.layers;
  const manifest = assembleManifest(cfg, { tenant: 'vanburen' });
  assert.deepEqual(manifest.sources.map(s => s.id).sort(), ['aerial', 'county-drains', 'parcels', 'subdivisions', 'wetlands']);
  assert.equal(loadManifest(manifest).ok, true);
});

test('an existing manifest with a real sources[] is passed through, not re-derived', () => {
  const cfg = Object.assign(countyConfig(), {
    tenant: 'vanburen',
    sources: [{ id: 'zoning', type: 'vector', idField: 'zone_id' }],
  });
  const manifest = assembleManifest(cfg, { tenant: 'vanburen' });
  assert.deepEqual(manifest.sources, [{ id: 'zoning', type: 'vector', idField: 'zone_id' }]);
});

test('passthrough carries county-config blocks onto the manifest (the grown superset)', () => {
  const cfg = Object.assign(countyConfig(), {
    state: 'MI',
    parcelNumber: { label: 'Parcel Number', separator: '-', segments: [{ name: 'County code' }] },
    labels: { propClass: { '401': 'Residential' } },
    forms: { dataRequest: 'https://form' },
  });
  const m = assembleManifest(cfg, {
    tenant: 'vanburen',
    passthrough: ['state', 'parcelNumber', 'labels', 'forms'],
  });
  assert.equal(m.state, 'MI');
  assert.deepEqual(m.parcelNumber.segments, [{ name: 'County code' }]);
  assert.equal(m.labels.propClass['401'], 'Residential');
  assert.equal(m.forms.dataRequest, 'https://form');
  // The grown manifest still schema-validates (passthrough fields are additive).
  assert.equal(loadManifest(m).ok, true);
});

test('passthrough never clobbers an assembler-derived field', () => {
  const cfg = Object.assign(countyConfig(), { branding: { evil: true } });
  const m = assembleManifest(cfg, { tenant: 'vanburen', passthrough: ['branding'] });
  assert.equal(m.branding.name, 'Van Buren County');   // assembler's branding, not the raw passthrough
});

test('a config missing tenant still assembles, and loadManifest flags it (no silent pass)', () => {
  const cfg = countyConfig();      // no tenant, no opts.tenant → derived from name slug
  const manifest = assembleManifest(cfg);
  assert.equal(manifest.tenant, 'van-buren-county');   // slug fallback
  assert.equal(loadManifest(manifest).ok, true);
  // But a truly tenant-less config (blank name) is caught by the validator, not hidden.
  const blank = assembleManifest({ map: { center: [0, 0], zoom: 1 }, data: { baseLayers: [{ id: 's' }] } });
  assert.equal(blank.tenant, '');
  assert.equal(loadManifest(blank).ok, false);
  assert.match(loadManifest(blank).errors.join('\n'), /tenant/);
});
