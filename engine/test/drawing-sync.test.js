'use strict';
// Drawing-stack single-source guard (A8 / DIC-575). The 5 shared drawing files are
// generated from one master in engine/drawing/; this fails if a copy drifts from the
// master (i.e. someone edited PV's or ZIP's copy directly instead of the master +
// re-running the generator). In CI only the PV side is present; the ZIP side is checked
// when the sibling repo is on disk.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('engine drawing masters match the checked-in PV (+ ZIP) copies — no drift', async () => {
  const gen = await import('../drawing/generate.mjs');
  const masterDir = path.resolve(__dirname, '..', 'drawing');
  const repo = path.resolve(__dirname, '..', '..');
  const claude = path.resolve(repo, '..');

  for (const f of gen.SHARED_FILES) {
    const master = fs.readFileSync(path.join(masterDir, f + '.js'), 'utf8');
    const pv = fs.readFileSync(path.join(repo, 'frontend', 'public', 'js', 'drawing', f + '.js'), 'utf8');
    assert.equal(pv, master, f + '.js: PV copy drifted from the master — run `node engine/drawing/generate.mjs`');

    const zipPath = path.join(claude, 'ZIP', 'zip-poc', 'frontend', 'drawing', f + '.js');
    if (fs.existsSync(zipPath)) {
      const zip = fs.readFileSync(zipPath, 'utf8');
      assert.equal(zip, gen.toZipNamespace(master), f + '.js: ZIP copy drifted from the master — re-run the generator');
    }
  }
});

test('toZipNamespace rewrites namespace tokens but never substrings', async () => {
  const gen = await import('../drawing/generate.mjs');
  assert.equal(gen.toZipNamespace('window.PS_MAP = map;'), 'window.ZIP_MAP = map;');
  assert.equal(gen.toZipNamespace('PS_ANNOTATION_STORE'), 'ZIP_ANNOTATION_STORE');
  assert.equal(gen.toZipNamespace('var ps_bearing = 1;'), 'var zip_bearing = 1;');
  assert.equal(gen.toZipNamespace('maps_count'), 'maps_count');   // substring left alone
  assert.equal(gen.toZipNamespace('GROUPS_'), 'GROUPS_');
});
