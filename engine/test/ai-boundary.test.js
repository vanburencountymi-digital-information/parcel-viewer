'use strict';
// AI-NEVER-IN-THE-CRITICAL-PATH (§4.3). The deterministic core must run without any
// AI, and narrate() must NEVER be invoked on the AI-off path. We prove it with a
// narrator that records whether it was called.
const { test } = require('node:test');
const assert = require('node:assert');

const ISV = require('../capability.js');

function spyCapability() {
  let coreCalls = 0, narrateCalls = 0;
  const reg = ISV.createRegistry();
  reg.register({
    id: 'spy',
    aiMode: 'ai-optional',
    core: (input) => { coreCalls++; return { facts: { echo: input.x }, provenance: [] }; },
    narrate: () => { narrateCalls++; return { said: 'hi' }; },
  });
  return { reg, calls: () => ({ coreCalls, narrateCalls }) };
}

test('AI-off: core runs, narrate does NOT', async () => {
  const { reg, calls } = spyCapability();
  const r = await reg.invoke('spy', { x: 1 }, { ai: false });
  assert.equal(calls().coreCalls, 1);
  assert.equal(calls().narrateCalls, 0);   // the critical guarantee
  assert.equal(r.narration, null);
});

test('AI-on: core still runs first, then narrate', async () => {
  const { reg, calls } = spyCapability();
  const r = await reg.invoke('spy', { x: 1 }, { ai: true });
  assert.equal(calls().coreCalls, 1);
  assert.equal(calls().narrateCalls, 1);
  assert.deepEqual(r.narration, { said: 'hi' });
});

test("no-ai capability rejects a narrate() at registration", () => {
  const reg = ISV.createRegistry();
  assert.throws(() => reg.register({ id: 'bad', aiMode: 'no-ai', core: () => ({ facts: {} }), narrate: () => ({}) }),
    /'no-ai' must not define narrate/);
});

test("ai-required capability must define narrate()", () => {
  const reg = ISV.createRegistry();
  assert.throws(() => reg.register({ id: 'bad', aiMode: 'ai-required', core: () => ({ facts: {} }) }),
    /'ai-required' must define narrate/);
});

test('ai-required runs narration even with no explicit request (toggle is absent)', async () => {
  const reg = ISV.createRegistry();
  reg.register({ id: 'req', aiMode: 'ai-required', core: () => ({ facts: {}, provenance: [] }), narrate: () => ({ ok: true }) });
  const r = await reg.invoke('req', {}, {}); // no ai flag at all
  assert.deepEqual(r.narration, { ok: true });
});

test('core returning a bad shape is rejected (contract enforcement)', async () => {
  const reg = ISV.createRegistry();
  reg.register({ id: 'malformed', aiMode: 'no-ai', core: () => ({ nope: 1 }) });
  await assert.rejects(reg.invoke('malformed', {}, {}), /must return \{ facts, provenance \}/);
});

test('aiApplies resolves the tri-state correctly', () => {
  const reg = ISV.createRegistry();
  assert.equal(reg.aiApplies('no-ai', true), false);
  assert.equal(reg.aiApplies('ai-required', false), true);
  assert.equal(reg.aiApplies('ai-optional', false), false); // default OFF / opt-in (§4.4a)
  assert.equal(reg.aiApplies('ai-optional', true), true);
});
