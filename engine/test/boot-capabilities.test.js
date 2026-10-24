'use strict';
// DIC-2266: the page's boot (installViewerHooks, engine/browser.js) must register the v1
// capabilities in the shared registry, or the viewer's ISV.invoke('ledger') rejects with
// "unknown capability ledger". (The ledger and explainer windows are Vue components now,
// DIC-2389; their rendering is tested with Vitest in frontend/src/windows/.)
const { test } = require('node:test');
const assert = require('node:assert');

test('the viewer boot registers the v1 capabilities in the shared registry', () => {
  const w = require('../window-hooks.js').installViewerHooks({});
  const ids = w.ISV.list().map((c) => c.id).sort();
  assert.deepStrictEqual(ids, ['cohort-analyze', 'explainer', 'ledger', 'theme-composer']);
});

test('ISV.invoke runs the ledger capability without a model', async () => {
  const w = require('../window-hooks.js').installViewerHooks({});
  const fixture = require('./fixtures/ledger-events.json');
  const res = await w.ISV.invoke('ledger', { events: fixture.events }, { ai: false });
  assert.deepStrictEqual(res.facts, w.ISV_LEDGER_CORE.core(fixture).facts);
  assert.ok(Array.isArray(res.provenance) && res.provenance.length > 0, 'native provenance');
});
