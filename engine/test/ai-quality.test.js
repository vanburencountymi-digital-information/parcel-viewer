'use strict';
// AI-quality eval (C5 / DIC-586): citation-accuracy + grounding checks. Deterministic,
// no live model — golden output passes; hallucinated law / originated figures fail.
const { test } = require('node:test');
const assert = require('node:assert');

const Q = require('../ai-quality.js');
const corpus = require('../data/mi-tax-statutes.json').statutes;

// A real parcel's verified figures (the explainer's deterministic core output).
const FACTS = {
  assessed_value: 98000, taxable_value: 72340,
  prev_assessed_value: 94500, prev_taxable_value: 70980,
  true_cash_value_estimate: 196000,
  assessed_value_history: [98000, 94500, 91200, 88000, 85100],
};

const GOOD = {
  summary: 'Your Assessed Value is $98,000 and your Taxable Value is $72,340.',
  sections: [{ heading: 'True Cash Value', body: 'Estimated market value is about $196,000 (twice AV).' }],
  glossary: [{ term: 'AV', definition: 'Assessed at 50% of True Cash Value.' }],
  statutes: [
    { name: 'Taxable Value cap (Proposal A)', citation: 'MCL 211.27a(2)', plain: 'TV rises by the lesser of 5% or CPI.' },
    { name: 'Michigan Tax Tribunal', citation: 'MCL 205.731', plain: 'Appeals beyond the Board of Review.' },
  ],
  disclaimer: 'Educational only.',
};

test('a grounded, well-cited explanation passes', () => {
  const r = Q.evaluateExplanation(GOOD, { facts: FACTS, corpus });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.citations.violations, []);
  assert.deepEqual(r.grounding.violations, []);
});

test('conceptual numbers (50%, 5%) are not policed as dollar amounts', () => {
  const r = Q.checkGrounding('Assessed at 50% of value; TV rises by 5% a year.', FACTS);
  assert.equal(r.ok, true);
});

test('HALLUCINATED law is caught: a citation not in the corpus fails', () => {
  const bad = Object.assign({}, GOOD, {
    statutes: [{ name: 'Made-up Act', citation: 'MCL 999.123', plain: 'Not a real statute.' }],
  });
  const r = Q.evaluateExplanation(bad, { facts: FACTS, corpus });
  assert.equal(r.ok, false);
  assert.equal(r.citations.violations[0].mcl, '999.123');
  assert.match(r.citations.violations[0].reason, /not in corpus/);
});

test('an uncitable statute (no MCL) is a violation, not a free pass', () => {
  const r = Q.checkCitations([{ name: 'Vibes', citation: 'trust me' }], corpus);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /no resolvable MCL/);
});

test('ORIGINATED figures are caught: a dollar amount not in the facts fails', () => {
  const bad = Object.assign({}, GOOD, {
    summary: 'Your home is worth $500,000 and taxes are $12,345.',
  });
  const r = Q.evaluateExplanation(bad, { facts: FACTS, corpus });
  assert.equal(r.ok, false);
  const amounts = r.grounding.violations.map((v) => v.amount).sort((a, b) => a - b);
  assert.deepEqual(amounts, [12345, 500000]);
});

test('MCL core extraction is format-tolerant (subsections, prefixes)', () => {
  assert.deepEqual(Q.mclCores('MCL 211.27a(2)'), ['211.27a']);
  assert.deepEqual(Q.mclCores('Mich. Const. Art. IX; MCL 211.7cc and 211.7dd'), ['211.7cc', '211.7dd']);
  assert.deepEqual(Q.mclCores('no citation here'), []);
});

test('the whole curated corpus self-validates (every entry resolves)', () => {
  // Every statute the explainer is allowed to cite must itself be citation-accurate.
  const r = Q.checkCitations(corpus, corpus);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

// ── Cohort narration grounding (DIC-588) — the deterministic floor under /describe-cohort ──
const COHORT_CORE = require('../capabilities/cohort-analyze.core.js');
const COHORT_FACTS = COHORT_CORE.core({
  cohort: { selector: { type: 'buffer', label: '¼ mi of #1' }, features: [
    { id: 1, properties: { prop_class: '401', gis_acres: 2,  assessed_value: 100000, prev_assessed_value: 90000,  owner_name: 'Smith' } },
    { id: 2, properties: { prop_class: '401', gis_acres: 4,  assessed_value: 120000, prev_assessed_value: 120000, owner_name: 'Smith' } },
    { id: 3, properties: { prop_class: '201', gis_acres: 10, assessed_value: 300000, prev_assessed_value: 320000, owner_name: 'Jones' } },
    { id: 4, properties: { prop_class: '101', gis_acres: 40, assessed_value: 50000,  prev_assessed_value: 50000,  owner_name: 'Acme Farms' } },
  ] },
  fields: { area: 'gis_acres', category: 'prop_class', owner: 'owner_name',
    values: [{ key: 'assessed_value', prev: 'prev_assessed_value', label: 'Assessed Value' }] },
}).facts;

test('cohort: a character read citing only computed figures is grounded', () => {
  // median AV 110000, total 570000 (currentTotal) are both in the facts.
  const good = {
    headline: 'Established residential area',
    character: 'Mostly residential, owner-occupied, stable values',
    paragraphs: [
      'This is a predominantly residential area, with a couple of commercial and agricultural parcels mixed in.',
      'The median assessed value is about $110,000, and assessed values across the area total $570,000.',
    ],
    caveats: ['Aggregates public assessment data; not an official valuation.'],
  };
  const r = Q.evaluateCohortNarration(good, { facts: COHORT_FACTS });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('cohort: qualitative reads with shares/counts (no dollars) are not policed', () => {
  const r = Q.checkCohortGrounding('Half the parcels are residential; one owner holds 2 of them.', COHORT_FACTS);
  assert.equal(r.ok, true);
});

test('cohort: an ORIGINATED dollar amount not in the figures is caught', () => {
  const bad = {
    headline: 'A pricey area',
    paragraphs: ['Homes here are worth around $750,000 and rents run $2,400 a month.'],
  };
  const r = Q.evaluateCohortNarration(bad, { facts: COHORT_FACTS });
  assert.equal(r.ok, false);
  const amounts = r.grounding.violations.map((v) => v.amount).sort((a, b) => a - b);
  assert.deepEqual(amounts, [2400, 750000]);
});
