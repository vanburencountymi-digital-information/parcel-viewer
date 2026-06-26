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
    },
    // The Data & Layers editor stores arrays under `layers` (county-config.js shape).
    layers: {
      baseLayers: [
        { id: 'parcels', label: 'Parcels', source: 'County PostGIS', default: true },
        { id: 'aerial', label: 'Aerial imagery', type: 'raster', source: 'State imagery' },
      ],
      overlays: [
        { id: 'subdivisions', label: 'Subdivisions', type: 'vector', sourceLayer: 'subdivisions', minZoom: 12, source: 'geo.subdivisions' },
        { id: 'wetlands', label: 'Wetlands', type: 'WMS', source: 'USFWS NWI', minZoom: 12 },
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
  assert.deepEqual(manifest.sources.map(s => s.id).sort(), ['aerial', 'parcels', 'subdivisions', 'wetlands']);
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
