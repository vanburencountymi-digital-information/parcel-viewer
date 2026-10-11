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
const { loadFile } = require('./helpers/sandbox.js');

const REPO = path.resolve(__dirname, '..', '..');
const ledgerFixture = require('./fixtures/ledger-events.json');

async function makeViewer() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.console = console;
  vm.createContext(sandbox);
  const load = (p) => vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: p });
  await loadFile(sandbox, 'frontend/public/js/pv-template.js');
  // The engine is ES modules now (DIC-2180): put its window hooks on the sandbox, as the
  // page's engine entry (engine/browser.js) does, capabilities registered.
  require('../window-hooks.js').installViewerHooks(sandbox);
  await loadFile(sandbox, 'frontend/public/js/pv-ledger.js');
  return sandbox;
}

test('pv-ledger.js loads and consumes the shared ledger core', async () => {
  const w = (await makeViewer());
  assert.ok(w.PV_LEDGER, 'PV_LEDGER should be defined');
  assert.ok(w.ISV_LEDGER_CORE, 'ledger core should be loaded');
});

test('renderLedger renders live events: years, categories, recorded vs inferred', async () => {
  const w = (await makeViewer());
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

test('empty ledger degrades to a clean message, not an error', async () => {
  const w = (await makeViewer());
  const facts = w.ISV_LEDGER_CORE.core({ events: [] }).facts;
  const html = w.PV_LEDGER.renderLedger(facts);
  assert.match(html, /No recorded events for this parcel yet/);
});

// DIC-2266: the page's boot (installViewerHooks) must register the v1 capabilities, or
// fetchLedger's ISV.invoke('ledger') rejects with "unknown capability ledger".
test('the viewer boot registers the v1 capabilities in the shared registry', async () => {
  const w = (await makeViewer());
  const ids = w.ISV.list().map((c) => c.id).sort();
  assert.deepStrictEqual(ids, ['cohort-analyze', 'explainer', 'ledger', 'theme-composer']);
});

test('fetchLedger runs the history endpoint through ISV.invoke to facts', async () => {
  const w = (await makeViewer());
  const urls = [];
  w.fetch = (url) => {
    urls.push(url);
    return Promise.resolve({ ok: true, json: () => Promise.resolve(ledgerFixture) });
  };
  const res = await w.PV_LEDGER.fetchLedger(4021);
  assert.deepStrictEqual(urls, ['/api/parcel/4021/history']);
  assert.deepStrictEqual(res.facts, w.ISV_LEDGER_CORE.core(ledgerFixture).facts);
  assert.ok(Array.isArray(res.provenance) && res.provenance.length > 0, 'native provenance');
});
