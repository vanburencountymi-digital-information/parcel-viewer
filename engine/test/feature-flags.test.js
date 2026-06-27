'use strict';
// Per-tenant feature flags (C4 / DIC-585). A staged-rollout / per-tenant-rollback override
// layer over the manifest capability tri-state — reuses the toggle primitives, doesn't
// invent a new flag system. The manifest is never mutated.
const { test } = require('node:test');
const assert = require('node:assert');

const FLAGS = require('../feature-flags.js');
const { loadManifest } = require('../load-manifest.js');

function manifest() {
  return {
    manifestVersion: '1.0', id: 'v', tenant: 'vanburen',
    map: { center: [-86, 42], zoom: 11 },
    sources: [{ id: 'parcels', type: 'vector' }],
    capabilities: {
      search: { ai: 'no-ai' },
      explainer: { ai: 'ai-optional', disclosure: 'basic' },
      mapBuddy: { ai: 'ai-optional' },
    },
    persona: { audience: 'public' },
  };
}

test('no flags → capabilities unchanged (manifest untouched)', () => {
  const m = manifest();
  const caps = FLAGS.resolveCapabilities(m, {});
  assert.deepEqual(caps, m.capabilities);
  assert.deepEqual(Object.keys(m.capabilities), ['search', 'explainer', 'mapBuddy']);  // input intact
});

test('flag false gates a capability OFF for this tenant (rollback)', () => {
  const caps = FLAGS.resolveCapabilities(manifest(), { mapBuddy: false });
  assert.ok(!caps.mapBuddy);
  assert.ok(caps.search && caps.explainer);
  assert.equal(FLAGS.isEnabled(manifest(), 'mapBuddy', { mapBuddy: false }), false);
});

test('flag true canaries a capability not in the manifest (catalog default config)', () => {
  const caps = FLAGS.resolveCapabilities(manifest(), { cogo: true });
  assert.ok(caps.cogo);
  assert.equal(caps.cogo.ai, 'ai-optional');   // from the capability catalog
});

test('object flag overrides a capability config (e.g. flip a tenant to ai-off)', () => {
  const caps = FLAGS.resolveCapabilities(manifest(), { explainer: { ai: 'no-ai' } });
  assert.equal(caps.explainer.ai, 'no-ai');
  assert.equal(caps.explainer.disclosure, 'basic');   // preserved
});

test('applyFlags returns a manifest that still schema-validates', () => {
  const flagged = FLAGS.applyFlags(manifest(), { mapBuddy: false, cogo: true });
  assert.deepEqual(loadManifest(flagged).errors, []);
  assert.ok(!flagged.capabilities.mapBuddy && flagged.capabilities.cogo);
  // original manifest untouched
  assert.ok(manifest().capabilities.mapBuddy);
});

test('different tenants get different effective capabilities from the same manifest', () => {
  const base = manifest();
  const countyA = FLAGS.resolveCapabilities(base, { cogo: true });            // canary cogo for A
  const countyB = FLAGS.resolveCapabilities(base, { explainer: false });      // roll explainer back for B
  assert.ok(countyA.cogo && !countyB.cogo);
  assert.ok(countyB.explainer === undefined && countyA.explainer);
});
