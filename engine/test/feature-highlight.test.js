'use strict';
// Feature-state highlighter (A4 / DIC-569, slice 2). Source-agnostic; map injected
// (incl. lazily as a function); event-driven single-active highlight via the bus.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HL = require('../feature-highlight.js');
const CTX = require('../app-context.js');

function fakeMap() {
  const calls = [];
  return { calls, setFeatureState: (ref, state) => calls.push({ ref, state }) };
}

test('set() writes feature-state for the configured source', () => {
  const map = fakeMap();
  const h = HL.createFeatureHighlighter({ map, sourceId: 'parcels', sourceLayer: 'parcels' });
  h.set('80-1', { selected: true });
  assert.deepEqual(map.calls[0], { ref: { source: 'parcels', sourceLayer: 'parcels', id: '80-1' }, state: { selected: true } });
});

test('a non-parcel source works through the same helper (§4.1)', () => {
  const map = fakeMap();
  const h = HL.createFeatureHighlighter({ map, sourceId: 'zoning', sourceLayer: 'zoning' });
  h.set('R-1', { active: true });
  assert.equal(map.calls[0].ref.source, 'zoning');
});

test('map can be injected lazily as a function (created late)', () => {
  let real = null;
  const h = HL.createFeatureHighlighter({ map: () => real, sourceId: 's', sourceLayer: 's' });
  h.set('x', { a: 1 });                  // no map yet → no-op, no throw
  real = fakeMap();
  h.set('y', { a: 1 });
  assert.equal(real.calls.length, 1);
  assert.equal(real.calls[0].ref.id, 'y');
});

test('set() is a safe no-op without a map or id, and swallows map errors', () => {
  const h0 = HL.createFeatureHighlighter({ map: null, sourceId: 's', sourceLayer: 's' });
  assert.doesNotThrow(() => h0.set('x', {}));
  const bad = { setFeatureState: () => { throw new Error('source not loaded'); } };
  const h1 = HL.createFeatureHighlighter({ map: bad, sourceId: 's', sourceLayer: 's' });
  assert.doesNotThrow(() => h1.set('x', {}));
  h1.set(null, {});                       // null id → no-op
});

test('bindActive drives a single-active slot off the bus (clear prev, set next)', () => {
  const map = fakeMap();
  const bus = CTX.createEventBus();
  const h = HL.createFeatureHighlighter({ map, sourceId: 'parcels', sourceLayer: 'parcels' });
  h.bindActive(bus, { stateKey: 'activeInfo' });

  bus.emit('active-feature-changed', { ref: { id: 'a' } });
  bus.emit('active-feature-changed', { ref: { id: 'b' } });
  bus.emit('active-feature-changed', { ref: null });

  assert.deepEqual(map.calls.map((c) => [c.ref.id, c.state.activeInfo]), [
    ['a', true],            // a on
    ['a', false],           // a off (previous)
    ['b', true],            // b on
    ['b', false],           // b off on clear
  ]);
});

test('the highlighter is source-agnostic (§4.1)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'feature-highlight.js'), 'utf8');
  assert.ok(!/\bparcel/i.test(src), 'feature-highlight.js must not mention parcels');
});
