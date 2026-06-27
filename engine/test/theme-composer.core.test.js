'use strict';
// Theme Composer / AI autoconfigure capability (B3 / DIC-579). The DRAFT manifest is
// deterministic (facts), schema-valid, and identical AI-on vs AI-off (facts-parity);
// the AI layer only adds prose rationale as narration. So autoconfigure works with NO AI.
const { test } = require('node:test');
const assert = require('node:assert');

const COMPOSER = require('../capabilities/theme-composer.core.js');
const { loadManifest } = require('../load-manifest.js');
const ISV = require('../capability.js');
const { registerAll } = require('../capabilities/register.js');

function brief(extra) {
  return Object.assign({
    tenant: 'vanburen',
    name: 'Van Buren County',
    topic: 'parcels, assessment and tax',
    intent: 'public',
    sources: [
      { id: 'parcels', type: 'vector', idField: 'pin' },
      { id: 'wetlands', type: 'wms' },
    ],
    center: [-86.03, 42.24],
    zoom: 11,
  }, extra || {});
}

test('the draft manifest is schema-valid — round-trips loadManifest (the AC)', () => {
  const out = COMPOSER.core(brief());
  const res = loadManifest(out.facts.draftManifest);
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
  assert.equal(out.facts.draftManifest.tenant, 'vanburen');
  assert.deepEqual(out.facts.draftManifest.sources.map(s => s.id).sort(), ['parcels', 'wetlands']);
});

test('topic/intent deterministically drive capability selection', () => {
  const out = COMPOSER.core(brief());
  const caps = out.facts.draftManifest.capabilities;
  // baseline + assessment/tax topic → explainer + citations + mapBuddy.
  ['search', 'parcelInfo', 'layers', 'print', 'share', 'explainer', 'citations', 'mapBuddy'].forEach(id => {
    assert.ok(caps[id], 'expected capability ' + id);
  });
  assert.equal(caps.explainer.ai, 'ai-optional');
  assert.equal(caps.search.ai, 'no-ai');
  assert.equal(out.facts.draftManifest.persona.audience, 'public');
});

test('survey intent adds COGO + drawing/measure; staff intent → staff audience', () => {
  const out = COMPOSER.core(brief({ topic: 'survey traverse', intent: 'staff analysis' }));
  const caps = out.facts.draftManifest.capabilities;
  assert.ok(caps.cogo && caps.drawing && caps.measure);
  assert.equal(out.facts.draftManifest.persona.audience, 'staff');
});

test('ai:false omits Map Buddy', () => {
  const out = COMPOSER.core(brief({ ai: false }));
  assert.ok(!out.facts.draftManifest.capabilities.mapBuddy);
});

test('provenance ties each choice to a brief input (citation envelope §6.4)', () => {
  const out = COMPOSER.core(brief());
  assert.ok(out.provenance.length > 0);
  out.provenance.forEach(p => {
    assert.equal(p.source_id, 'brief');
    assert.ok(p.anchor && p.span);
    assert.equal(p.state, 'resolves');
  });
  assert.ok(out.provenance.some(p => p.anchor === 'capabilities.explainer'));
});

test('a deterministic rationale exists even with AI off (degrade-to-facts)', () => {
  const out = COMPOSER.core(brief());
  assert.match(out.facts.rationale, /Audience: public/);
  assert.match(out.facts.rationale, /explainer/);
});

test('facts-parity + graceful absence via invoke(): draft identical AI-off vs AI-on', async () => {
  const reg = registerAll(ISV.createRegistry());

  // AI OFF (no transport) — narration degrades to null, draft stands.
  const off = await reg.invoke('theme-composer', brief(), { ai: false });
  assert.equal(off.narration, null);
  assert.equal(loadManifest(off.facts.draftManifest).ok, true);

  // AI ON — a mocked refiner adds prose; the DRAFT (facts) is byte-identical.
  const on = await reg.invoke('theme-composer', brief(), {
    ai: true,
    ctx: {
      fetchComposerNarration: (facts) => ({
        rationale: 'AI prose about ' + facts.capabilities.length + ' caps', suggestions: [],
      }),
    },
  });
  assert.deepEqual(on.facts, off.facts);                       // facts-parity (§4.6)
  assert.ok(on.narration && /AI prose/.test(on.narration.rationale));
  assert.equal(on.meta.aiApplied, true);
});
