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
  return fs.readdirSync(THEMES_DIR).filter((f) => f.endsWith('.json'));
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
