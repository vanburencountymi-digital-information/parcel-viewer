'use strict';
// AppContext + event bus (A3 / DIC-568). The injected seam that replaces window.PS_*.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CTX = require('../app-context.js');

test('createAppContext exposes injected slots (new code reads context, not globals)', () => {
  const fakeMap = { id: 'map' };
  const ctx = CTX.createAppContext({ map: fakeMap, config: { tenant: 'vanburen' }, state: { selected: 7 } });
  assert.equal(ctx.map, fakeMap);
  assert.equal(ctx.config.tenant, 'vanburen');
  assert.equal(ctx.state.selected, 7);
  assert.ok(ctx.bus, 'a bus is always present');
  assert.deepEqual(ctx.stores, {});
});

test('slots are LIVE getters — a bridge getter tracks the current value', () => {
  let current = { z: 1 };
  const ctx = CTX.createAppContext({ get map() { return current; } });
  assert.equal(ctx.map.z, 1);
  current = { z: 2 };
  assert.equal(ctx.map.z, 2, 'ctx.map should reflect the latest underlying object');
});

test('event bus: on/emit/off/once', () => {
  const bus = CTX.createEventBus();
  const seen = [];
  const off = bus.on('selection-changed', (d) => seen.push(d));
  bus.emit('selection-changed', { id: 1 });
  bus.emit('selection-changed', { id: 2 });
  off();
  bus.emit('selection-changed', { id: 3 });   // after off → ignored
  assert.deepEqual(seen, [{ id: 1 }, { id: 2 }]);

  let onceCount = 0;
  bus.once('active-feature-changed', () => onceCount++);
  bus.emit('active-feature-changed');
  bus.emit('active-feature-changed');
  assert.equal(onceCount, 1);
});

test('a throwing listener does not break emit for the others', () => {
  const bus = CTX.createEventBus();
  let reached = false;
  bus.on('x', () => { throw new Error('boom'); });
  bus.on('x', () => { reached = true; });
  assert.doesNotThrow(() => bus.emit('x'));
  assert.equal(reached, true);
});

test('the engine app-context is source-agnostic and names no global (§4.1)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app-context.js'), 'utf8');
  assert.ok(!/\bparcel/i.test(src), 'app-context.js must be source-agnostic');
  assert.ok(!/PS_MAP|PS_STATE|window\.PS_|root\.PS_/.test(src), 'global names belong in the viewer bridge, not the engine');
});
