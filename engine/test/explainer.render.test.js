'use strict';
// Render-path integration smoke (A7a): loads the REAL pv-template.js, engine cores,
// and the live pv-explain.js in a minimal browser-ish sandbox, then asserts the
// re-expressed explainer:
//   - AI-off  → facts + curated statute LINKS, no prose (§4.5)
//   - AI-on   → narration over the SAME facts (§4.6 facts-parity at the render layer)
//   - the live file consumes the shared engine core (single source of truth)
// No browser, no network, no model — CI-runnable.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..', '..');           // parcel-viewer/
const corpus = require('../data/mi-tax-statutes.json');
const parcel = require('./fixtures/parcel-assessment.json');
const county = require('./fixtures/county-labels.json');

function makeViewer() {
  // Minimal browser globals the explainer touches at render time.
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.console = console;
  sandbox.location = { hostname: 'localhost' };
  sandbox.document = { documentElement: { getAttribute: () => null } };
  sandbox.fetch = () => Promise.reject(new Error('no network in test'));
  sandbox.COUNTY = { name: 'Van Buren County', labels: county.labels, parcelNumber: county.parcelNumber };
  vm.createContext(sandbox);

  const load = (p) => vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: p });
  load(path.join(REPO, 'frontend/public/js/pv-template.js'));
  load(path.join(REPO, 'engine/capability.js'));
  load(path.join(REPO, 'engine/capabilities/explainer.core.js'));
  load(path.join(REPO, 'engine/capabilities/ledger.core.js'));
  load(path.join(REPO, 'engine/capabilities/register.js'));
  load(path.join(REPO, 'frontend/public/js/pv-explain.js'));
  return sandbox;
}

test('the live pv-explain.js loads and consumes the shared engine core', () => {
  const w = makeViewer();
  assert.ok(w.PV_EXPLAIN, 'PV_EXPLAIN should be defined');
  assert.ok(w.ISV_EXPLAINER_CORE, 'engine core should be loaded');
  // The viewer-facing facts come from the SAME core the harness tests.
  const facts = w.ISV_EXPLAINER_CORE.buildAssessmentFacts(parcel, { labels: county.labels, currentYear: 2026 });
  assert.equal(facts.assessed_value, 98000);
  assert.equal(facts.classification, '401 – Residential');
});

test('AI-OFF renders facts + curated statute LINKS, no prose (§4.5)', () => {
  const w = makeViewer();
  const facts = w.ISV_EXPLAINER_CORE.buildAssessmentFacts(parcel, { labels: county.labels, currentYear: 2026 });
  const html = w.PV_EXPLAIN.renderHtml(facts, null, 'assessment', corpus.statutes);

  assert.match(html, /\$98,000/, 'recorded figures must show AI-off');
  assert.match(html, /Michigan law/, 'statute section heading');
  assert.match(html, /MCL 211\.27a/, 'a curated statute citation');
  assert.match(html, /<a [^>]*href="http[^"]*legislature\.mi\.gov[^"]*"/, 'statutes render as LINKS');
  // No prose walkthrough AI-off: the old educational paragraph must be gone.
  assert.doesNotMatch(html, /Assessing values every parcel for taxation/, 'no prose fallback AI-off');
});

test('AI-ON adds narration over the IDENTICAL facts (render-layer facts-parity)', () => {
  const w = makeViewer();
  const facts = w.ISV_EXPLAINER_CORE.buildAssessmentFacts(parcel, { labels: county.labels, currentYear: 2026 });
  const explanation = {
    summary: 'Your assessed value is $98,000.',
    sections: [{ heading: 'What these mean', body: 'Plain body.' }],
    glossary: [], statutes: [{ name: 'Proposal A', citation: 'MCL 211.27a(2)', plain: 'cap' }],
    disclaimer: 'Educational only.',
  };
  const htmlOn = w.PV_EXPLAIN.renderHtml(facts, explanation, 'assessment', corpus.statutes);
  const htmlOff = w.PV_EXPLAIN.renderHtml(facts, null, 'assessment', corpus.statutes);

  // Same facts present in BOTH (the figures don't move when AI flips).
  assert.match(htmlOn, /\$98,000/);
  assert.match(htmlOff, /\$98,000/);
  // Narration appears only AI-on.
  assert.match(htmlOn, /Your assessed value is \$98,000/);
  assert.doesNotMatch(htmlOff, /What these mean/);
});
