'use strict';
// Manifest schema versioning + migration (C2 / DIC-583). The engine auto-upgrades an
// older manifest to the current shape; a newer-than-supported version is rejected; the
// migrated manifest still validates (so an old stored config renders, the AC).
const { test } = require('node:test');
const assert = require('node:assert');

const MV = require('../manifest-version.js');
const { validate } = require('../validate-manifest.js');
const v09 = require('./fixtures/manifest-v0.9.json');
const v10 = require('./fixtures/manifest-valid.json');

test('compareVersions orders X.Y correctly', () => {
  assert.equal(MV.compareVersions('0.9', '1.0'), -1);
  assert.equal(MV.compareVersions('1.0', '1.0'), 0);
  assert.equal(MV.compareVersions('2.0', '1.0'), 1);
  assert.equal(MV.compareVersions('1.10', '1.9'), 1);   // numeric, not lexical
});

test('migrate(v0.9): capabilities array → per-capability object with AI tri-state', () => {
  const r = MV.migrate(v09);
  assert.equal(r.ok, true);
  assert.equal(r.fromVersion, '0.9');
  assert.equal(r.toVersion, '1.0');
  assert.deepEqual(r.applied, ['0.9→1.0']);
  assert.equal(r.manifest.manifestVersion, '1.0');
  // The flat list became config carrying the AI mode.
  assert.deepEqual(r.manifest.capabilities.search, { ai: 'no-ai' });
  assert.deepEqual(r.manifest.capabilities.explainer, { ai: 'ai-optional' });
  assert.deepEqual(r.manifest.capabilities.mapBuddy, { ai: 'ai-optional' });
  // Input not mutated.
  assert.ok(Array.isArray(v09.capabilities));
});

test('the migrated v0.9 manifest now VALIDATES (old stored config still renders)', () => {
  const migrated = MV.migrate(v09).manifest;
  const res = validate(migrated);
  assert.deepEqual(res.errors, []);
  assert.equal(res.valid, true);
});

test('migrate(current) is idempotent — no steps applied', () => {
  const r = MV.migrate(v10);
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, []);
  assert.equal(r.toVersion, MV.CURRENT_VERSION);
});

test('a newer-than-supported manifestVersion is REJECTED, not guessed', () => {
  const future = Object.assign({}, v10, { manifestVersion: '2.0' });
  const r = MV.migrate(future);
  assert.equal(r.ok, false);
  assert.match(r.error, /newer than the engine supports/);
  assert.equal(MV.isSupported('2.0'), false);
});

test('a missing manifestVersion is treated as the oldest shape and upgraded', () => {
  const legacy = { id: 'x', tenant: 't', map: { center: [0, 0], zoom: 1 }, sources: [{ id: 's', type: 'vector' }], capabilities: ['search'] };
  const r = MV.migrate(legacy);
  assert.equal(r.ok, true);
  assert.equal(r.manifest.manifestVersion, '1.0');
  assert.deepEqual(r.manifest.capabilities.search, { ai: 'no-ai' });
});

test('isSupported: current + migratable older are supported; unknown future is not', () => {
  assert.equal(MV.isSupported('1.0'), true);
  assert.equal(MV.isSupported('0.9'), true);
  assert.equal(MV.isSupported('0.5'), false);   // no migration path
  assert.equal(MV.isSupported('2.0'), false);
});
