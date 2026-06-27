'use strict';
// AI-quality eval for the theme-composer (C5 / DIC-586). Generalizes citation-accuracy
// to the §6.4 envelope and adds a grounding gate: the autoconfigure draft must be fully
// grounded — every enabled capability + persona traces to a provenance entry.
const { test } = require('node:test');
const assert = require('node:assert');

const Q = require('../ai-quality.js');
const COMPOSER = require('../capabilities/theme-composer.core.js');

function brief() {
  return {
    tenant: 'vanburen', name: 'Van Buren County',
    topic: 'parcels, assessment and tax', intent: 'public',
    sources: [{ id: 'parcels', type: 'vector', idField: 'pin' }],
    center: [-86, 42], zoom: 11,
  };
}

test('a real composer draft is grounded + has a well-formed envelope', () => {
  const out = COMPOSER.core(brief());
  const r = Q.evaluateComposer(out);
  assert.deepEqual(r.grounding.violations, []);
  assert.deepEqual(r.envelope.violations, []);
  assert.equal(r.ok, true);
});

test('an UNGROUNDED capability (in the manifest, no provenance) is caught', () => {
  const out = COMPOSER.core(brief());
  // Smuggle a capability into the draft without a matching provenance entry.
  out.facts.draftManifest.capabilities.visionDescribe = { ai: 'ai-optional' };
  const r = Q.evaluateComposer(out);
  assert.equal(r.ok, false);
  assert.ok(r.grounding.violations.some(v => v.capability === 'visionDescribe'));
});

test('checkEnvelope: an uncitable (state "none") claim is freelancing → violation', () => {
  const r = Q.checkEnvelope([{ source_id: 'brief', anchor: 'a', span: 's', state: 'none' }], ['brief']);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /uncitable|freelancing/);
});

test('checkEnvelope: a "resolves" citation to an unknown source is a hallucinated source', () => {
  const r = Q.checkEnvelope([{ source_id: 'made-up', anchor: 'a', span: 's', state: 'resolves' }], ['brief']);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /not in the allowed set/);
});

test('checkEnvelope: malformed entries (missing source_id/span/bad state) are caught', () => {
  assert.equal(Q.checkEnvelope([{ anchor: 'a', span: 's', state: 'resolves' }]).ok, false);          // no source_id
  assert.equal(Q.checkEnvelope([{ source_id: 'b', anchor: 'a', state: 'resolves' }]).ok, false);     // no span
  assert.equal(Q.checkEnvelope([{ source_id: 'b', anchor: 'a', span: 's', state: 'bogus' }]).ok, false);
});

test('checkEnvelope: "coarse" is honest degradation, not a violation', () => {
  const r = Q.checkEnvelope([{ source_id: 'brief', anchor: 'a', span: 's', state: 'coarse' }], ['brief']);
  assert.deepEqual(r.violations, []);
  assert.equal(r.ok, true);
});
