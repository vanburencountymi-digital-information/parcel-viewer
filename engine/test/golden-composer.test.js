'use strict';
// Golden corpus for the theme-composer / autoconfigure (C5 / DIC-586). Pins the
// deterministic autoconfigure behavior across representative briefs: each golden case's
// draft must be schema-valid, fully grounded (evaluateComposer), and match the expected
// capabilities/audience. This is the regression bar the AI refinement narrates OVER.
const { test } = require('node:test');
const assert = require('node:assert');

const COMPOSER = require('../capabilities/theme-composer.core.js');
const Q = require('../ai-quality.js');
const { loadManifest } = require('../load-manifest.js');
const corpus = require('./fixtures/golden-composer.json');

for (const c of corpus.cases) {
  test('golden: ' + c.name, () => {
    const out = COMPOSER.core(c.brief);
    const m = out.facts.draftManifest;

    // 1) schema-valid (round-trips loadManifest)
    assert.deepEqual(loadManifest(m).errors, [], c.name + ': not schema-valid');

    // 2) fully grounded — every enabled capability/persona traces to provenance (C5 gate)
    const q = Q.evaluateComposer(out);
    assert.equal(q.ok, true, c.name + ': not grounded — ' + JSON.stringify(q.grounding.violations));

    // 3) deterministic expectations
    assert.equal(m.persona.audience, c.expect.audience, c.name + ': audience');
    for (const id of c.expect.hasCapabilities) {
      assert.ok(m.capabilities[id], c.name + ': expected capability ' + id);
    }
    for (const id of c.expect.lacksCapabilities) {
      assert.ok(!m.capabilities[id], c.name + ': should NOT have capability ' + id);
    }
  });
}

test('golden corpus covers >= 3 representative cases', () => {
  assert.ok(corpus.cases.length >= 3);
});
