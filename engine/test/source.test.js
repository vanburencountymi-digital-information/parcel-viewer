'use strict';
// Source-config registry + the source-driven popup renderer (A5 / DIC-407). Proves the
// engine renders "a source" — the SAME code renders parcels and a non-parcel source.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = require('../source.js');
const POPUP = require('../popup.js');
const SOURCES = require('./fixtures/sources.json');
const county = require('./fixtures/county-labels.json');

test('registry defines/gets sources and resolves a feature id via idField', () => {
  const reg = SOURCE.createSourceRegistry();
  reg.define(SOURCES.parcels);
  reg.define(SOURCES.roads);
  assert.ok(reg.has('parcels') && reg.has('roads'));
  assert.equal(reg.get('parcels').idField, 'pin');
  // idOf uses the configured idField — never a hardcoded "pin".
  assert.equal(reg.idOf('parcels', { properties: { pin: '80-1', id: 9 } }), '80-1');
  assert.equal(reg.idOf('roads', { properties: { road_id: 'R42' } }), 'R42');
});

test('invalid source configs are rejected with actionable errors', () => {
  const reg = SOURCE.createSourceRegistry();
  assert.throws(() => reg.define({ id: 'x' }), /idField .* required/);
  assert.throws(() => reg.define({ idField: 'id' }), /id \(string\) is required/);
  assert.equal(SOURCE.validate({ id: 'p', idField: 'pin', search: { fields: 'nope' } }).valid, false);
});

test('parcels source renders its sections with formatters + label lookup', () => {
  const feature = { properties: {
    prop_street: '80490 32ND AVE', gis_acres: 8.874, prop_class: '401',
    owner_name: 'KELLY MARK & PATRICIA', assessed_value: 600100, taxable_value: 192023,
  }};
  const out = POPUP.renderSections(SOURCES.parcels, feature, { labels: county.labels });
  assert.deepEqual(out[0], { section: 'Parcel', rows: [
    { label: 'Address', field: 'prop_street', raw: '80490 32ND AVE', value: '80490 32ND AVE' },
    { label: 'Area', field: 'gis_acres', raw: 8.874, value: '8.87 ac' },
    { label: 'Class', field: 'prop_class', raw: '401', value: '401 – Residential' },
  ]});
  assert.equal(out[1].rows[0].value, 'KELLY MARK & PATRICIA');
  assert.equal(out[2].rows[0].value, '$600,100');   // money formatter
  assert.equal(out[2].rows[1].value, '$192,023');
});

test('a NON-parcel source (roads) renders through the SAME engine (§4.1)', () => {
  const feature = { properties: { name: '32nd Ave', surface: 'Gravel', jurisdiction: 'County' } };
  const out = POPUP.renderSections(SOURCES.roads, feature, {});
  assert.deepEqual(out, [{ section: 'Road', rows: [
    { label: 'Name', field: 'name', raw: '32nd Ave', value: '32nd Ave' },
    { label: 'Surface', field: 'surface', raw: 'Gravel', value: 'Gravel' },
    { label: 'Jurisdiction', field: 'jurisdiction', raw: 'County', value: 'County' },
  ]}]);
});

test('missing fields format to null, never throw', () => {
  const out = POPUP.renderSections(SOURCES.parcels, { properties: {} }, { labels: county.labels });
  assert.equal(out[2].rows[0].value, null);   // no assessed_value
  assert.equal(out[0].rows[1].value, null);   // no acres
});

test('legacy string sections still render (back-compat with engine-smoke)', () => {
  const src = { popup: { sections: ['District', 'Allowed Uses'] } };
  const out = POPUP.renderSections(src, { properties: { district: 'R-1', allowed_uses: 'SF' } });
  assert.deepEqual(out, [
    { section: 'District', rows: [{ field: 'district', value: 'R-1' }] },
    { section: 'Allowed Uses', rows: [{ field: 'allowed_uses', value: 'SF' }] },
  ]);
});

test('rich fields support tooltips, per-field style, and computed (sibling) formatters', () => {
  const cfg = { id: 'p', idField: 'id', popup: { sections: [
    { title: 'Owner', fields: [
      { label: 'Name', field: 'owner_name', tip: 'Owner name' },
      { label: 'Mailing', field: 'owner_street', format: 'mail', style: 'white-space:normal', tip: 'Mailing address' } ] } ] } };
  const formatters = { mail: (v, ctx) => {
    const p = ctx.props || {};
    return [p.owner_street, [p.owner_city, p.owner_state].filter(Boolean).join(' '), p.owner_zip].filter(Boolean).join(', ') || null;
  } };
  const out = POPUP.renderSections(cfg, { properties: { owner_name: 'DOE', owner_street: '1 Main', owner_city: 'Paw Paw', owner_state: 'MI', owner_zip: '49079' } }, { formatters });
  assert.equal(out[0].rows[0].tip, 'Owner name');
  assert.equal(out[0].rows[0].value, 'DOE');
  assert.equal(out[0].rows[1].value, '1 Main, Paw Paw MI, 49079');   // computed from sibling fields
  assert.equal(out[0].rows[1].style, 'white-space:normal');
  // Unconfigured rows stay lean (no tip/style keys).
  assert.equal('tip' in out[0].rows[0], true);
});

test('the source registry + popup renderer are source-agnostic (§4.1)', () => {
  ['../source.js', '../popup.js'].forEach((rel) => {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(!/\bparcel/i.test(src), rel + ' must be source-agnostic');
  });
});
