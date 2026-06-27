'use strict';
// ParcelStore contract single-source guard (A6 / DIC-570, D1). The canonical-parcel
// record shape is defined once in engine/stores/parcel_contract.py and generated verbatim
// into both backends; this fails if a copy drifted (someone edited a backend's copy
// instead of the master + re-running `node engine/stores/generate.mjs`). In CI only the PV
// copy is present; the ZIP copy is checked when the sibling repo is on disk.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

test('parcel_contract.py master matches the PV (+ ZIP) generated copies — no drift', async () => {
  const gen = await import('../stores/generate.mjs');
  const master = gen.masterSource();

  const pv = fs.readFileSync(gen.PV_PATH, 'utf8');
  assert.equal(pv, master, 'PV parcel_contract.py drifted from the master — run `node engine/stores/generate.mjs`');

  if (fs.existsSync(gen.ZIP_PATH)) {
    const zip = fs.readFileSync(gen.ZIP_PATH, 'utf8');
    assert.equal(zip, master, 'ZIP parcel_contract.py drifted from the master — re-run the generator');
  }
});
