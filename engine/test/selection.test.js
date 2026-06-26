'use strict';
// SelectionManager (A4 / DIC-569, slice 1) — the selection state machine, testable in
// isolation, feature-agnostic, announcing on the bus. No map, no DOM, no PIN.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SEL = require('../selection.js');
const CTX = require('../app-context.js');

function harness() {
  const bus = CTX.createEventBus();
  const events = [];
  bus.on('selection-changed', (d) => events.push(['selection', d]));
  bus.on('active-feature-changed', (d) => events.push(['active', d]));
  const mgr = SEL.createSelectionManager({ bus, defaultSourceId: 'parcels' });
  return { mgr, events };
}

test('select emits selection-changed with the feature ref + previous', () => {
  const { mgr, events } = harness();
  mgr.select({ id: 7, properties: { pin: '80-1' } });
  assert.equal(mgr.selected.id, 7);
  assert.equal(mgr.selected.sourceId, 'parcels');     // default applied
  assert.deepEqual(events[0][1].ref, { sourceId: 'parcels', id: 7, properties: { pin: '80-1' } });
  assert.equal(events[0][1].previous, null);
});

test('re-selecting the same feature is a no-op (no duplicate event)', () => {
  const { mgr, events } = harness();
  mgr.select({ id: 7 });
  mgr.select({ id: 7 });
  assert.equal(events.length, 1);
});

test('selecting a different feature carries the previous ref', () => {
  const { mgr, events } = harness();
  mgr.select({ id: 7 });
  mgr.select({ id: 9 });
  assert.equal(events[1][1].previous.id, 7);
  assert.equal(events[1][1].ref.id, 9);
});

test('clear emits a null selection and is a no-op when nothing is selected', () => {
  const { mgr, events } = harness();
  mgr.clear();                          // nothing selected → no event
  assert.equal(events.length, 0);
  mgr.select({ id: 7 });
  mgr.clear();
  assert.equal(events[1][1].ref, null);
  assert.equal(events[1][1].previous.id, 7);
});

test('active feature is tracked separately from selection', () => {
  const { mgr, events } = harness();
  mgr.setActive({ id: 3 });
  assert.equal(mgr.active.id, 3);
  assert.equal(mgr.selected, null);
  assert.equal(events[0][0], 'active');
  mgr.clearActive();
  assert.equal(mgr.active, null);
});

test('is feature-agnostic: a bare id and a non-parcel source work', () => {
  const { mgr } = harness();
  mgr.select({ sourceId: 'zoning', id: 'R-1' });
  assert.equal(mgr.selected.sourceId, 'zoning');
  assert.equal(mgr.selected.id, 'R-1');
});

test('the engine selection module is source-agnostic (§4.1)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'selection.js'), 'utf8');
  assert.ok(!/\bparcel/i.test(src), 'selection.js must not mention parcels');
  assert.ok(!/PS_[A-Z]/.test(src), 'selection.js must not name a global');
});
