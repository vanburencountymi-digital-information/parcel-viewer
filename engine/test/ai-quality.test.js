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
