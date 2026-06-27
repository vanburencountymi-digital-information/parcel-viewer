'use strict';
// Engine smoke (§4.1 source-agnostic): boot a manifest, pick a NON-PARCEL source,
// render its popup sections over a feature. Proves the engine renders "a source",
// not "parcels" — and that "parcel" is absent from the engine path.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { validate } = require('../validate-manifest.js');
const { renderSections } = require('../popup.js');
const manifest = require('./fixtures/manifest-valid.json');

test('manifest boots (validates) and exposes multiple sources', () => {
  assert.equal(validate(manifest).valid, true);
  const ids = manifest.sources.map((s) => s.id);
  assert.ok(ids.includes('parcels') && ids.includes('zoning'));
});

test('a NON-parcel source renders through the same popup engine', () => {
  const zoning = manifest.sources.find((s) => s.id === 'zoning');
  const feature = { properties: { district: 'R-1 Residential', allowed_uses: 'Single-family, ADU' } };
  const sections = renderSections(zoning, feature);
  assert.deepEqual(sections, [
    { section: 'District', rows: [{ field: 'district', value: 'R-1 Residential' }] },
    { section: 'Allowed Uses', rows: [{ field: 'allowed_uses', value: 'Single-family, ADU' }] },
  ]);
});

test('the engine modules contain no "parcel" assumption (§4.1)', () => {
  // The contract seam, validator, and popup engine must not mention parcels.
  ['../capability.js', '../validate-manifest.js', '../popup.js', '../doc.js', '../app-context.js', '../selection.js', '../feature-highlight.js', '../source.js', '../manifest-version.js', '../load-manifest.js', '../manifest-assemble.js', '../tenant.js', '../citation.js'].forEach((rel) => {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(!/\bparcel/i.test(src), rel + ' must not mention "parcel" (source-agnostic engine)');
  });
});
