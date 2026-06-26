'use strict';
// Render-path integration smoke (A7c): loads the REAL pv-template.js, engine cores,
// and the live pv-ledger.js, then asserts the decoupled ledger renders live facts:
// recorded vs. inferred events, survey-quality signals, honest "no document" state.
// No browser, no network, no model.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..', '..');
const ledgerFixture = require('./fixtures/ledger-events.json');

function makeViewer() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.console = console;
  vm.createContext(sandbox);
  const load = (p) => vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: p });
  load(path.join(REPO, 'frontend/public/js/pv-template.js'));
  load(path.join(REPO, 'engine/capability.js'));
  load(path.join(REPO, 'engine/capabilities/ledger.core.js'));
  load(path.join(REPO, 'engine/capabilities/register.js'));
  load(path.join(REPO, 'frontend/public/js/pv-ledger.js'));
  return sandbox;
}

test('pv-ledger.js loads and consumes the shared ledger core', () => {
  const w = makeViewer();
  assert.ok(w.PV_LEDGER, 'PV_LEDGER should be defined');
  assert.ok(w.ISV_LEDGER_CORE, 'ledger core should be loaded');
});

test('renderLedger renders live events: years, categories, recorded vs inferred', () => {
  const w = makeViewer();
  const facts = w.ISV_LEDGER_CORE.core(ledgerFixture).facts;
  const html = w.PV_LEDGER.renderLedger(facts);

  assert.match(html, /2021/, 'survey year');
  assert.match(html, /Boundary survey/);
  assert.match(html, /Survey/);                                   // category label
  assert.match(html, /L2021-0473 Recorded Survey/);               // recorded → source linked
  assert.match(html, /Bowditch-adjusted/);                        // survey-quality signal shown
  assert.match(html, /No document of record \(inferred\)/);       // honest 'none' state (§6.4)
  assert.match(html, /pp-ldot--inf/, 'inferred dot style for the undocumented event');
});

test('empty ledger degrades to a clean message, not an error', () => {
  const w = makeViewer();
  const facts = w.ISV_LEDGER_CORE.core({ events: [] }).facts;
  const html = w.PV_LEDGER.renderLedger(facts);
  assert.match(html, /No recorded events for this parcel yet/);
});
