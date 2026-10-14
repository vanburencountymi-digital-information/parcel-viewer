'use strict';
// ParcelStore contract single-source guard (A6 / DIC-570, D1). The canonical-parcel
// record shape is defined once in engine/stores/parcel_contract.py and generated verbatim
// into each backend with a ParcelStore; this fails if a copy drifted (someone edited the
// copy instead of the master + re-running `node engine/stores/generate.mjs`). Today the
// only copy is ZIP's, checked when the sibling repo is on disk (not in CI). The Parcel
// Viewer's copy went with its FastAPI backend (DIC-2150).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

test('parcel_contract.py master matches the ZIP generated copy — no drift', async (t) => {
  const gen = await import('../stores/generate.mjs');
  const master = gen.masterSource();
  assert.ok(master.includes('ParcelStore'), 'the master defines the ParcelStore contract');
  if (!fs.existsSync(gen.ZIP_PATH)) {
    t.skip('ZIP sibling repo not on disk');
    return;
  }
  const zip = fs.readFileSync(gen.ZIP_PATH, 'utf8');
  assert.equal(zip, master, 'ZIP parcel_contract.py drifted from the master — re-run the generator');
});
