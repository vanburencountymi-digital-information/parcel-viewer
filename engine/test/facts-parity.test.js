'use strict';
// FACTS-PARITY (§4.6) — the headline acceptance check for the whole platform.
// Turning AI on or off must not change the FACTS or the PROVENANCE a capability
// returns; only `narration` appears/disappears. This is what makes "degrade to
// facts" (§4.5) an enforced invariant rather than a hope.
const { test } = require('node:test');
const assert = require('node:assert');

const ISV = require('../capability.js');
const { registerAll } = require('../capabilities/register.js');
const parcel = require('./fixtures/parcel-assessment.json');
const county = require('./fixtures/county-labels.json');
const corpus = require('../data/mi-tax-statutes.json');

function freshRegistry() { return registerAll(ISV.createRegistry()); }

const baseInput = {
  topic: 'assessment', record: parcel,
  labels: county.labels, parcelNumber: county.parcelNumber,
  currentYear: 2026, statutes: corpus.statutes,
};

// A mock narrator standing in for POST /explain. It is ONLY allowed to cite from
// the provenance it was handed — mirroring the real "narrate, never originate"
// discipline. If it tried to cite something outside provenance, the test below
// would catch it.
function mockNarrator(facts, provenance) {
  const citable = new Set(provenance.map((c) => c.source_id).filter(Boolean));
  const cited = provenance.slice(0, 2).map((c) => c.source_id); // narrator "chooses" two
  cited.forEach((id) => assert.ok(citable.has(id), 'narrator cited outside provenance: ' + id));
  return {
    summary: `Your assessed value is $${facts.assessed_value}.`,
    statutes_cited: cited,
  };
}

test('explainer: facts + provenance are identical AI-off vs AI-on', async () => {
  const reg = freshRegistry();

  const off = await reg.invoke('explainer', baseInput, { ai: false });
  const on = await reg.invoke('explainer', baseInput, {
    ai: true, ctx: { topic: 'assessment', fetchNarration: mockNarrator },
  });

  // The whole point: facts and provenance do not move.
  assert.deepEqual(on.facts, off.facts, 'facts changed when AI turned on');
  assert.deepEqual(on.provenance, off.provenance, 'provenance changed when AI turned on');

  // Only narration differs.
  assert.equal(off.narration, null);
  assert.ok(on.narration && on.narration.summary, 'AI-on should add narration');
  assert.equal(off.meta.aiApplied, false);
  assert.equal(on.meta.aiApplied, true);
});

test('facts-parity holds for the no-ai ledger capability too (AI request is a no-op)', async () => {
  const LEDGER_FIXTURE = require('./fixtures/ledger-events.json');
  const reg = freshRegistry();
  const off = await reg.invoke('ledger', LEDGER_FIXTURE, { ai: false });
  const on = await reg.invoke('ledger', LEDGER_FIXTURE, { ai: true }); // ignored: aiMode no-ai
  assert.deepEqual(on.facts, off.facts);
  assert.deepEqual(on.provenance, off.provenance);
  assert.equal(on.narration, null);
  assert.equal(on.meta.aiApplied, false);
});

test('the AI-off provenance universe IS the AI-on citable set (literal §4.6)', async () => {
  const reg = freshRegistry();
  const off = await reg.invoke('explainer', baseInput, { ai: false });
  const universe = new Set(off.provenance.map((c) => c.source_id));
  // Every curated statute the narrator could cite is present AI-off as a link.
  corpus.statutes.forEach((s) => assert.ok(universe.has(s.citation), 'missing AI-off citation for ' + s.citation));
});

test('automatic fallback: an unreachable narrator degrades to facts, never throws', async () => {
  const reg = freshRegistry();
  const result = await reg.invoke('explainer', baseInput, {
    ai: true,
    ctx: { topic: 'assessment', fetchNarration: () => { throw new Error('service down'); } },
  });
  assert.equal(result.narration, null);     // degraded, not errored
  assert.equal(result.meta.degraded, true);
  assert.deepEqual(result.facts, (await reg.invoke('explainer', baseInput, { ai: false })).facts);
});
