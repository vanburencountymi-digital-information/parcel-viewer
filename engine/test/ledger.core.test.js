'use strict';
// Deterministic-core tests for the Ledger capability (A2). No model; native provenance.
const { test } = require('node:test');
const assert = require('node:assert');

const LEDGER = require('../capabilities/ledger.core.js');
const fixture = require('./fixtures/ledger-events.json');

test('ledger normalizes events and restates survey-quality signals as-is', () => {
  const { facts } = LEDGER.core(fixture);
  assert.equal(facts.event_count, 3);
  const survey = facts.events[0];
  assert.equal(survey.event_type, 'boundary_survey');
  assert.equal(survey.closure_error, 0.018);
  assert.equal(survey.precision_ratio, 14200);
  assert.equal(survey.bowditch_applied, true);
  assert.deepEqual(survey.related_parcel_ids, [4022]);
  assert.equal(facts.has_survey_quality, true);
});

test('native provenance: documented events → coarse citations, undocumented → none', () => {
  const { provenance } = LEDGER.core(fixture);
  assert.equal(provenance.length, 3);
  assert.equal(provenance[0].state, 'coarse');
  assert.equal(provenance[0].source_id, 'L2021-0473 Recorded Survey');
  assert.equal(provenance[0].anchor, '11111111-1111-1111-1111-111111111111');
  // Honest degradation: an event with no document of record cites nothing (§6.4).
  assert.equal(provenance[2].state, 'none');
  assert.equal(provenance[2].source_id, null);
});

test('sourced_count reflects only events with a source document', () => {
  const { facts } = LEDGER.core(fixture);
  assert.equal(facts.sourced_count, 2);
});

test('empty / missing events degrade cleanly', () => {
  assert.deepEqual(LEDGER.core({ events: [] }).facts, { event_count: 0, events: [], sourced_count: 0, has_survey_quality: false });
  assert.equal(LEDGER.core({}).facts.event_count, 0);
});

test('display model (A7c): event_type → category, recorded flag, title, year', () => {
  const model = LEDGER.ledgerDisplayModel(LEDGER.core(fixture).facts);
  // Newest-first.
  assert.deepEqual(model.events.map((e) => e.year), [2021, 2019, 2018]);
  assert.deepEqual(model.span, { from: 2018, to: 2021 });

  const survey = model.events[0];
  assert.equal(survey.category, 'survey');
  assert.equal(survey.category_label, 'Survey');
  assert.equal(survey.recorded, true);            // has a source document
  assert.equal(survey.title, 'Boundary survey');  // humanized event_type
  assert.equal(survey.survey.bowditch_applied, true);

  const split = model.events.find((e) => e.title === 'Split');
  assert.equal(split.category, 'land');

  const correction = model.events.find((e) => e.title === 'Data correction');
  assert.equal(correction.recorded, false);       // no document of record → inferred
  assert.equal(correction.survey, null);
});

test('categorize keyword rules cover the common event families', () => {
  assert.equal(LEDGER.categorize('warranty_deed_transfer'), 'ownership');
  assert.equal(LEDGER.categorize('taxable_value_uncapped'), 'tax');
  assert.equal(LEDGER.categorize('lot_line_adjustment'), 'land');
  assert.equal(LEDGER.categorize('building_permit'), 'regulatory');
  assert.equal(LEDGER.categorize('aerial_imagery'), 'imagery');
  assert.equal(LEDGER.categorize('something_unknown'), 'record');   // honest default
});
