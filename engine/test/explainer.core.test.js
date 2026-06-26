'use strict';
// Deterministic-core tests for the Explainer capability (A2). No model, frozen
// fixtures, fixed currentYear so the year-labeled history is stable.
const { test } = require('node:test');
const assert = require('node:assert');

const EXPLAINER = require('../capabilities/explainer.core.js');
const parcel = require('./fixtures/parcel-assessment.json');
const taxParcel = require('./fixtures/parcel-taxdesc.json');
const county = require('./fixtures/county-labels.json');
const corpus = require('../data/mi-tax-statutes.json');

const CTX = { labels: county.labels, parcelNumber: county.parcelNumber, currentYear: 2026 };

test('assessment facts: figures restated, never originated', () => {
  const f = EXPLAINER.buildAssessmentFacts(parcel, CTX);
  assert.equal(f.pin, '80-08-032-002-00');
  assert.equal(f.assessed_value, 98000);
  assert.equal(f.taxable_value, 72340);
  // True Cash Value is a clearly-labeled deterministic 2× derivation (not a new fact).
  assert.equal(f.true_cash_value_estimate, 196000);
  assert.equal(f.classification, '401 – Residential');     // code-name via county labels
  assert.equal(f.school_district, 'Mattawan Consolidated Schools');
  assert.equal(f.pre_percent, 100);
});

test('assessment history is year-labeled oldest→newest and drops nulls', () => {
  const f = EXPLAINER.buildAssessmentFacts(parcel, CTX);
  assert.deepEqual(f.assessed_value_by_year, [
    { year: 2022, assessed_value: 85100 },
    { year: 2023, assessed_value: 88000 },
    { year: 2024, assessed_value: 91200 },
    { year: 2025, assessed_value: 94500 },
    { year: 2026, assessed_value: 98000 },
  ]);
});

test('missing figures are omitted, never guessed', () => {
  const f = EXPLAINER.buildAssessmentFacts({ pin: 'X', assessed_value: null }, CTX);
  assert.equal(f.assessed_value, null);
  assert.equal(f.true_cash_value_estimate, null);   // no AV → no derived TCV
  assert.deepEqual(f.assessed_value_by_year, []);
});

test('description classifier detects metes-and-bounds without parsing geometry', () => {
  assert.equal(EXPLAINER.classifyDescription(taxParcel.legal_description).type, 'metes_bounds');
  assert.equal(EXPLAINER.classifyDescription('LOT 4 BLK 2 SUNNYSIDE ADD').type, 'platted_lot');
  assert.equal(EXPLAINER.classifyDescription('NW 1/4 OF SE 1/4 SEC 12 T1S R13W').type, 'aliquot_plss');
  assert.equal(EXPLAINER.classifyDescription('').type, 'unknown');
});

test('PIN breakdown is config-driven and zips parts to segment names', () => {
  const b = EXPLAINER.parsePinSegments('80-08-032-002-00', county.parcelNumber);
  assert.equal(b.parts.length, 5);
  assert.equal(b.parts[0].value, '80');
  assert.equal(b.parts[1].name, 'Local unit');
  assert.equal(EXPLAINER.parsePinSegments('80', county.parcelNumber), null); // single token → nothing
});

test('contract core() dispatches by topic and emits provenance', () => {
  const a = EXPLAINER.core({ topic: 'assessment', record: parcel, labels: county.labels, currentYear: 2026, statutes: corpus.statutes });
  assert.equal(a.facts.assessed_value, 98000);
  assert.equal(a.provenance.length, corpus.statutes.length);   // full curated corpus is the citable universe
  assert.equal(a.provenance[0].source_id, corpus.statutes[0].citation);

  const t = EXPLAINER.core({ topic: 'tax_description', record: taxParcel, parcelNumber: county.parcelNumber });
  assert.equal(t.facts.description_type, 'metes_bounds');
  assert.equal(t.provenance[0].source_id, 'assessment-roll');  // native-ish provenance
});

test('core never touches globals (pure given typed input)', () => {
  // A frozen input must not be mutated and must not require any ambient state.
  const input = Object.freeze({ topic: 'assessment', record: parcel, labels: county.labels, currentYear: 2026, statutes: corpus.statutes });
  assert.doesNotThrow(() => EXPLAINER.core(input));
});
