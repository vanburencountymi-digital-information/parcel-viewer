'use strict';
// load-manifest.js — the canonical migrate-on-load seam (C2 / DIC-583). migrate THEN
// validate, in one place: an old stored config is auto-upgraded and only then checked,
// so "an old stored config still renders" is enforced where everyone loads a manifest.
const { test } = require('node:test');
const assert = require('node:assert');

const { loadManifest } = require('../load-manifest.js');
const v09 = require('./fixtures/manifest-v0.9.json');
const v10 = require('./fixtures/manifest-valid.json');
const invalid = require('./fixtures/manifest-invalid.json');

test('loadManifest(v0.9): migrates up THEN validates — old config loads clean', () => {
  const r = loadManifest(v09);
  assert.equal(r.ok, true);
  assert.equal(r.fromVersion, '0.9');
  assert.equal(r.toVersion, '1.0');
  assert.deepEqual(r.applied, ['0.9→1.0']);
  assert.deepEqual(r.errors, []);
  // Output is the migrated (current-shape) manifest, not the raw input.
  assert.equal(r.manifest.manifestVersion, '1.0');
  assert.deepEqual(r.manifest.capabilities.explainer, { ai: 'ai-optional' });
  // Input not mutated.
  assert.ok(Array.isArray(v09.capabilities));
});

test('loadManifest(current valid) is ok with no migration steps', () => {
  const r = loadManifest(v10);
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.errors, []);
  assert.equal(r.toVersion, '1.0');
});

test('loadManifest rejects a migrated-but-invalid manifest with the validator errors', () => {
  // The invalid fixture is already v1.0, so migration is a no-op and validation is what fails.
  const r = loadManifest(invalid);
  assert.equal(r.ok, false);
  assert.deepEqual(r.applied, []);
  assert.ok(r.errors.length > 0);
  const joined = r.errors.join('\n');
  assert.match(joined, /missing required key: tenant/);
  // The migrated manifest is still returned so a caller can show what it tried to load.
  assert.ok(r.manifest && r.manifest.id === 'broken-viewer');
});

test('loadManifest rejects a newer-than-supported manifest before validating', () => {
  const future = Object.assign({}, v10, { manifestVersion: '2.0' });
  const r = loadManifest(future);
  assert.equal(r.ok, false);
  assert.deepEqual(r.applied, []);
  assert.match(r.errors.join('\n'), /newer than the engine supports/);
});

test('loadManifest rejects a non-object input', () => {
  assert.equal(loadManifest(null).ok, false);
  assert.equal(loadManifest('nope').ok, false);
  assert.ok(loadManifest(null).errors.length > 0);
});

test('a legacy manifest with NO manifestVersion is upgraded then validates', () => {
  const legacy = {
    id: 'x', tenant: 't',
    map: { center: [0, 0], zoom: 1 },
    sources: [{ id: 's', type: 'vector' }],
    capabilities: ['search', 'explainer'],
  };
  const r = loadManifest(legacy);
  assert.equal(r.ok, true);
  assert.equal(r.manifest.manifestVersion, '1.0');
  assert.deepEqual(r.manifest.capabilities.explainer, { ai: 'ai-optional' });
  assert.deepEqual(r.errors, []);
});
