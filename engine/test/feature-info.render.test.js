'use strict';
// Render-path test for the generic feature-info panel (A5 / DIC-407). Loads the engine
// popup renderer + the real pv-feature-info.js and asserts it turns any source into
// info-panel HTML, with an auto "Details" fallback for unconfigured sources.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..', '..');

function load() {
  const sandbox = {}; sandbox.window = sandbox; sandbox.self = sandbox; sandbox.console = console;
  vm.createContext(sandbox);
  const run = (p) => vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: p });
  run(path.join(REPO, 'engine/popup.js'));
  run(path.join(REPO, 'frontend/public/js/pv-feature-info.js'));
  return sandbox;
}

test('renders a NON-parcel source into info-panel HTML', () => {
  const w = load();
  const roads = { id: 'roads', idField: 'road_id', popup: { sections: [
    { title: 'Road', fields: [{ label: 'Name', field: 'name' }, { label: 'Surface', field: 'surface' }] } ] } };
  const html = w.PV_FEATURE_INFO.renderHtml(roads, { properties: { name: '32nd Ave', surface: 'Gravel' } }, null);
  assert.match(html, /Road/);
  assert.match(html, /32nd Ave/);
  assert.match(html, /Gravel/);
  assert.match(html, /parcel-info-row/);   // uses the panel's styling
});

test('auto "Details" fallback renders scalar fields and skips objects', () => {
  const w = load();
  const html = w.PV_FEATURE_INFO.renderHtml(null, { properties: { zone: 'R-1', max_ft: 35, geom: { x: 1 } } }, null);
  assert.match(html, /zone/);
  assert.match(html, /R-1/);
  assert.match(html, /max_ft/);
  assert.doesNotMatch(html, /geom/);        // object field skipped
});

test('empty feature degrades to a clean "No details" row, never throws', () => {
  const w = load();
  assert.doesNotThrow(() => w.PV_FEATURE_INFO.renderHtml(null, { properties: {} }, null));
  assert.match(w.PV_FEATURE_INFO.renderHtml(null, { properties: {} }, null), /No details/);
});

test('select renders detail and emits source-aware selection events', () => {
  const w = load();
  const events = [];
  const titleEl = { textContent: '' };
  const bodyEl = { innerHTML: '' };
  const panel = {
    hidden: true,
    querySelector: (sel) => sel === '.parcel-info-body' ? bodyEl : (sel === '.parcel-info-title' ? titleEl : null),
  };
  w.document = {
    getElementById: (id) => id === 'parcel-info-panel' ? panel : null,
  };
  w.PS_BUS = { emit: (type, detail) => events.push({ type, detail }) };
  w.CustomEvent = function CustomEvent(type, opts) { this.type = type; this.detail = opts && opts.detail; };
  w.dispatchEvent = () => {};

  const roads = { id: 'roads', idField: 'road_id', popup: { sections: [
    { title: 'Road', fields: [{ label: 'Name', field: 'name' }] },
  ] } };
  const ok = w.PV_FEATURE_INFO.select(roads, { properties: { road_id: 'R42', name: '32nd Ave' } }, { title: 'Roads' });

  assert.equal(ok, true);
  assert.equal(panel.hidden, false);
  assert.equal(titleEl.textContent, 'Roads');
  assert.match(bodyEl.innerHTML, /32nd Ave/);
  assert.deepEqual(events.map((e) => e.type), ['selection-changed', 'active-feature-changed']);
  assert.equal(events[0].detail.ref.sourceId, 'roads');
  assert.equal(events[0].detail.ref.id, 'R42');
});
