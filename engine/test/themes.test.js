'use strict';
// Theme manifests (Phase 5 — ZIP-as-a-theme / DIC-407). The "one engine, N themes" proof:
// every committed theme in engine/themes/ must pass the SAME loadManifest() gate (migrate-on-
// load → validate) the live viewer + CI use. Lockport Township (ZIP) is the second, materially
// different theme (zoning, not parcel-tax) — proving the engine/manifest describes more than PV.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { loadManifest } = require('../load-manifest.js');
const TENANT = require('../tenant.js');

const THEMES_DIR = path.join(__dirname, '..', 'themes');

function themeFiles() {
  if (!fs.existsSync(THEMES_DIR)) return [];
  // index.json is the theme REGISTRY, not a manifest — exclude it from the manifest round-trip.
  return fs.readdirSync(THEMES_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json');
}

test('every theme in engine/themes/ round-trips loadManifest (the AC)', () => {
  const files = themeFiles();
  assert.ok(files.length >= 1, 'expected at least one theme manifest');
  files.forEach((f) => {
    const raw = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, f), 'utf8'));
    const res = loadManifest(raw);
    assert.deepEqual(res.errors, [], f + ' must validate: ' + (res.errors || []).join('; '));
    assert.equal(res.ok, true, f + ' must load');
    assert.deepEqual(res.applied, [], f + ' should already be CURRENT_VERSION');
  });
});

// AC4 of the ISV acid test (engine/THEME_RENDERING_ACID_TEST.md): the engine must accept a
// theme it has NEVER seen — proving "one engine, N themes" isn't just the two hardcoded
// PV/ZIP cases. A synthetic third domain (parks) round-trips loadManifest, canonicalizes its
// tenant, and resolves capabilities generically — all with zero domain-specific engine code.
test('engine accepts an arbitrary third theme (not PV, not ZIP) — no hardcoded cases', () => {
  const synthetic = {
    manifestVersion: '1.0',
    id: 'acme-parks',
    tenant: 'acme-parks',
    branding: { name: 'Acme Parks & Trails' },
    map: { center: [-90, 40], zoom: 10 },
    sources: [
      { id: 'parks', type: 'vector', role: 'base', label: 'Parks', idField: 'park_id', default: true,
        popup: { sections: ['Park', 'Amenities'] } },
      { id: 'trails', type: 'vector', role: 'overlay', label: 'Trails', geomType: 'line' },
    ],
    capabilities: {
      search: { ai: 'no-ai', disclosure: 'basic' },
      layers: { ai: 'no-ai', disclosure: 'basic' },
      explainer: { ai: 'ai-optional', disclosure: 'basic' },
    },
  };
  const res = loadManifest(synthetic);
  assert.deepEqual(res.errors, [], (res.errors || []).join('; '));
  assert.equal(res.ok, true);
  const m = res.manifest;
  // Generic tenant handling — no PV/ZIP special-case (acme-parks registered ad hoc, as a new
  // county would be at deploy time).
  assert.equal(TENANT.canonicalTenant(m), 'acme-parks');
  TENANT.register('acme-parks', 'ACME');
  assert.equal(TENANT.dbCounty('acme-parks'), 'ACME');
  // Capabilities resolve generically through the same feature-flag engine the viewer uses.
  const FF = require('../feature-flags.js');
  const resolved = FF.resolveCapabilities(m, { search: false });   // a flag turns one off
  assert.ok(resolved.layers && resolved.explainer, 'untouched caps survive');
  assert.ok(!resolved.search, 'a flag gates a capability off — generically');
  // The source registry treats a non-parcel base source like any other.
  const base = m.sources.find((s) => s.role === 'base');
  assert.equal(base.id, 'parks');
  assert.deepEqual(base.popup.sections, ['Park', 'Amenities']);
});

test('theme registry (index.json) is consistent with the theme files', () => {
  const reg = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, 'index.json'), 'utf8'));
  assert.ok(Array.isArray(reg.themes) && reg.themes.length >= 1, 'registry must list themes');
  const ids = {};
  reg.themes.forEach((t) => {
    assert.ok(t.id && t.label, 'each registry entry needs id + label');
    assert.equal(ids[t.id], undefined, 'registry ids must be unique: ' + t.id);
    ids[t.id] = 1;
    // Every registered theme must have a manifest file present.
    assert.ok(fs.existsSync(path.join(THEMES_DIR, t.id + '.json')), 'missing theme file for ' + t.id);
  });
  // vanburen is the PV-bootable theme; lockport-township is registered but not PV-bootable yet.
  const vb = reg.themes.find((t) => t.id === 'vanburen');
  assert.ok(vb && vb.bootable === true, 'vanburen must be a bootable theme');
  // The gated chooser shows only with >1 bootable theme — assert today there is exactly one,
  // so the pulldown stays hidden until ZIP-as-a-theme (or a 2nd county) flips a second bootable.
  const bootable = reg.themes.filter((t) => t.bootable);
  assert.equal(bootable.length, 1, 'exactly one bootable theme today (chooser stays gated)');
});

test('vanburen theme is a faithful, bootable parcel manifest', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, 'vanburen.json'), 'utf8'));
  const res = loadManifest(raw);
  assert.equal(res.ok, true, (res.errors || []).join('; '));
  const m = res.manifest;
  assert.equal(m.id, 'vanburen');
  assert.equal(TENANT.canonicalTenant(m), 'vanburen');
  // Carries the COUNTY superset the viewer boots from (passthrough blocks), not just §5.
  ['labels', 'styling', 'parcelNumber', 'endpoints'].forEach((k) => assert.ok(m[k], 'vanburen theme must carry ' + k));
  // A parcel viewer: parcels base source + the tax ledger capability (vs ZIP's zoning theme).
  assert.ok(m.sources.find((s) => s.id === 'parcels' && s.role === 'base'));
  assert.ok(m.capabilities.ledger, 'vanburen has the parcel-tax ledger');
});

test('Lockport Township is a valid SECOND theme, distinct from a parcel-tax viewer', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, 'lockport-township.json'), 'utf8'));
  const res = loadManifest(raw);
  assert.equal(res.ok, true);
  const m = res.manifest;

  // A different jurisdiction/tenant than the VBC parcel viewer.
  assert.equal(m.tenant, 'lockport-township');
  assert.equal(TENANT.canonicalTenant(m), 'lockport-township');   // engine reads the canonical key

  // A zoning viewer, not a tax-parcel one: parcels source carries zoning, popup is zoning-oriented.
  const parcels = m.sources.find((s) => s.id === 'parcels');
  assert.equal(parcels.idField, 'pin');
  assert.ok(parcels.fields.includes('zoning'));
  assert.deepEqual(parcels.popup.sections, ['Parcel', 'Zoning']);

  // ZIP's capability mix differs from PV: it has the AI chat + ordinance citations, and
  // NO parcel-tax ledger (that's a PV capability). This is the "N themes" point.
  assert.ok(m.capabilities.mapBuddy, 'ZIP has the Map Buddy chat');
  assert.ok(m.capabilities.citations, 'ZIP cites the ordinance');
  assert.ok(!m.capabilities.ledger, 'ZIP has no tax ledger');

  // AI-optional everywhere (platform opt-in invariant §4.4a) — degrades to facts, never required.
  Object.values(m.capabilities).forEach((c) => {
    assert.ok(['no-ai', 'ai-optional', 'ai-required'].includes(c.ai));
    assert.notEqual(c.ai, 'ai-required');
  });
});
