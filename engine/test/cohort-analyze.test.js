'use strict';
// cohort-analyze.core.js (DIC-587) — the analysis-suite engine. Proves the deterministic
// aggregators, the §6.4 provenance, the contract integration (facts-parity AI-off +
// degrade-to-facts), and that the core is SOURCE-AGNOSTIC (config-driven fields → it
// profiles a non-parcel source too, §4.1).
const { test } = require('node:test');
const assert = require('node:assert');

const CORE = require('../capabilities/cohort-analyze.core.js');
const ISV = require('../capability.js');
const REGISTER = require('../capabilities/register.js');

// A small cohort of features (the spatial selection is the backend's job; here they're
// passed in as typed input). Shaped like assessment parcels, but the core only sees
// "features" + the field config below.
const FEATURES = [
  { id: 1, properties: { prop_class: '401', gis_acres: 2,  assessed_value: 100000, prev_assessed_value: 90000,  taxable_value: 80000,  prev_taxable_value: 78000,  owner_name: 'Smith' } },
  { id: 2, properties: { prop_class: '401', gis_acres: 4,  assessed_value: 120000, prev_assessed_value: 120000, taxable_value: 90000,  prev_taxable_value: 88000,  owner_name: 'Smith' } },
  { id: 3, properties: { prop_class: '201', gis_acres: 10, assessed_value: 300000, prev_assessed_value: 320000, taxable_value: 250000, prev_taxable_value: 240000, owner_name: 'Jones' } },
  { id: 4, properties: { prop_class: '101', gis_acres: 40, assessed_value: 50000,  prev_assessed_value: 50000,  taxable_value: 50000,  prev_taxable_value: 50000,  owner_name: 'Acme Farms' } },
];
const FIELDS = {
  area: 'gis_acres',
  category: 'prop_class',
  categoryLabels: { '401': 'Residential', '201': 'Commercial', '101': 'Agricultural' },
  owner: 'owner_name',
  values: [
    { key: 'assessed_value', prev: 'prev_assessed_value', label: 'Assessed Value' },
    { key: 'taxable_value',  prev: 'prev_taxable_value',  label: 'Taxable Value' },
  ],
};
const INPUT = { cohort: { selector: { type: 'buffer', label: '500 ft of #1' }, features: FEATURES }, fields: FIELDS, source_id: 'assessment-roll' };

test('stats: median is the average of the two middles for even n', () => {
  const s = CORE.stats([100000, 120000, 300000, 50000]);
  assert.equal(s.count, 4);
  assert.equal(s.sum, 570000);
  assert.equal(s.mean, 142500);
  assert.equal(s.median, 110000);   // (100000 + 120000) / 2
  assert.equal(s.min, 50000);
  assert.equal(s.max, 300000);
});

test('stats: ignores null/blank and handles empty', () => {
  assert.equal(CORE.stats(['', null, 5, undefined, 15]).median, 10);
  assert.deepEqual(CORE.stats([]), { count: 0, sum: 0, mean: null, median: null, min: null, max: null });
});

test('composition: count, area summary, and category mix (sorted, labelled, shares)', () => {
  const c = CORE.composition(FEATURES, FIELDS);
  assert.equal(c.count, 4);
  assert.equal(c.area.sum, 56);
  assert.equal(c.area.median, 7);   // (4 + 10) / 2
  // class 401 (2 features) leads; resolves the label; shares add to 1.
  assert.equal(c.categoryMix[0].key, '401');
  assert.equal(c.categoryMix[0].label, 'Residential');
  assert.equal(c.categoryMix[0].count, 2);
  assert.equal(c.categoryMix[0].area, 6);
  assert.equal(c.categoryMix[0].share, 0.5);
  assert.equal(c.categoryMix.reduce((t, e) => t + e.count, 0), 4);
});

test('value-stats: descriptive stats + per-area intensity', () => {
  const v = CORE.valueStats(FEATURES, FIELDS);
  assert.equal(v.assessed_value.label, 'Assessed Value');
  assert.equal(v.assessed_value.sum, 570000);
  assert.equal(v.assessed_value.median, 110000);
  assert.equal(v.assessed_value.perArea, 10178.57);   // 570000 / 56 acres
  assert.equal(v.taxable_value.sum, 470000);
});

test('value-change: current vs prior totals, delta %, up/down/flat counts', () => {
  const vc = CORE.valueChange(FEATURES, FIELDS).assessed_value;
  assert.equal(vc.currentTotal, 570000);
  assert.equal(vc.priorTotal, 580000);
  assert.equal(vc.deltaTotal, -10000);
  assert.equal(vc.deltaPct, -0.0172);   // -10000 / 580000
  assert.equal(vc.up, 1);    // #1 100k>90k
  assert.equal(vc.down, 1);  // #3 300k<320k
  assert.equal(vc.flat, 2);  // #2, #4 unchanged
});

test('ownership: distinct owners, top owner, multi-feature owners, HHI concentration', () => {
  const o = CORE.ownership(FEATURES, FIELDS);
  assert.equal(o.distinctOwners, 3);
  assert.equal(o.topOwner.owner, 'Smith');
  assert.equal(o.topOwner.count, 2);
  assert.equal(o.topOwner.share, 0.5);
  assert.equal(o.multiFeatureOwners, 1);             // only Smith holds >1
  assert.equal(o.concentrationHHI, 0.375);           // 0.5^2 + 0.25^2 + 0.25^2
});

test('ownership: blank/unmatched owners are separated; concentration is over KNOWN owners', () => {
  const feats = [
    { id: 1, properties: { owner_name: 'Smith' } },
    { id: 2, properties: { owner_name: 'Smith' } },
    { id: 3, properties: { owner_name: '' } },     // blank
    { id: 4, properties: { owner_name: null } },    // missing
  ];
  const o = CORE.ownership(feats, { owner: 'owner_name' });
  assert.equal(o.total, 4);
  assert.equal(o.unknownCount, 2);
  assert.equal(o.distinctOwners, 1);          // only Smith counts as an owner
  assert.equal(o.topOwner.owner, 'Smith');
  assert.equal(o.topOwner.share, 1);          // 2/2 KNOWN, not 2/4 total
  assert.equal(o.concentrationHHI, 1);        // a single known owner
});

test('area-distribution: histogram over configurable edges', () => {
  const d = CORE.areaDistribution(FEATURES, FIELDS);
  const counts = d.buckets.map((b) => b.count);
  // edges [1,5,20,40] → [<1, 1–5, 5–20, 20–40, ≥40]
  assert.deepEqual(counts, [0, 2, 1, 0, 1]);
  assert.equal(d.buckets[4].label, '≥ 40');
});

test('compare: transposes the cohort into a field×feature table, marks rows that differ', () => {
  const fields = { columnLabel: 'prop_class', compareFields: [
    { key: 'prop_class', label: 'Class' },
    { key: 'gis_acres', label: 'Acres' },
    { key: 'owner_name', label: 'Owner' },
  ] };
  // Compare just features #1 and #2 (both Smith, both 401, different acreage).
  const c = CORE.compare(FEATURES.slice(0, 2), fields);
  assert.deepEqual(c.columns.map((col) => ({ id: col.id, label: col.label })),
    [{ id: 1, label: '401' }, { id: 2, label: '401' }]);
  const byField = Object.fromEntries(c.rows.map((r) => [r.field, r]));
  assert.deepEqual(byField.prop_class.values, ['401', '401']);
  assert.equal(byField.prop_class.differs, false);   // same class
  assert.deepEqual(byField.gis_acres.values, [2, 4]);
  assert.equal(byField.gis_acres.differs, true);      // different acreage
  assert.equal(byField.owner_name.differs, false);    // both Smith
});

test('environmental: flood/wetland/soil composition from per-feature fields (clip-ready)', () => {
  // Synthetic features carrying the env fields that a future county wetland-clip will supply.
  const feats = [
    { id: 1, properties: { gis_acres: 10, flood_zone: 'AE', in_sfha: 'T', wetland_acres: 4, soil: 'Ms' } },
    { id: 2, properties: { gis_acres: 10, flood_zone: 'X', in_sfha: 'F', wetland_acres: 0, soil: 'Ms' } },
    { id: 3, properties: { gis_acres: 20, flood_zone: 'X', in_sfha: 'F', wetland_acres: 0, soil: 'Bd' } },
  ];
  const fields = { area: 'gis_acres', environmental: {
    floodZone: 'flood_zone', floodFlag: 'in_sfha', floodLabels: { AE: 'AE — base flood elev' },
    wetlandAcres: 'wetland_acres', soilClass: 'soil', soilLabels: { Ms: 'Marsh', Bd: 'Boyer sand' } } };
  const e = CORE.environmental(feats, fields);
  // flood: zone mix + share in a special flood hazard area
  assert.equal(e.flood.inSfhaCount, 1);
  assert.equal(e.flood.inSfhaShare, round3(1 / 3));
  assert.equal(e.flood.zoneMix[0].key, 'X');           // X leads (2 of 3)
  assert.equal(e.flood.zoneMix.find((z) => z.key === 'AE').label, 'AE — base flood elev');
  // wetland: parcels touching + acreage share of total area (4 of 40 acres)
  assert.equal(e.wetland.withWetlandCount, 1);
  assert.equal(e.wetland.wetlandAcres, 4);
  assert.equal(e.wetland.wetlandAcreShare, 0.1);
  // soil: class mix
  assert.equal(e.soil.soilMix[0].key, 'Ms');
  assert.equal(e.soil.soilMix[0].count, 2);
});

function round3(n) { return Math.round(n * 10000) / 10000; }

test('environmental: dormant when no env fields are configured (no data today)', () => {
  // The PROFILE today configures no environmental fields → the aggregator isn't even supported.
  assert.equal(CORE.supported({ area: 'gis_acres', category: 'prop_class' }).indexOf('environmental'), -1);
  assert.ok(CORE.supported({ area: 'a', environmental: { wetlandAcres: 'w' } }).indexOf('environmental') >= 0);
});

test('compare: a null vs a present value counts as differing', () => {
  const feats = [{ id: 1, properties: { x: 5 } }, { id: 2, properties: {} }];
  const c = CORE.compare(feats, { compareFields: [{ key: 'x', label: 'X' }] });
  assert.deepEqual(c.rows[0].values, [5, null]);
  assert.equal(c.rows[0].differs, true);
});

test('supported(): only aggregators the configured fields can back', () => {
  assert.deepEqual(CORE.supported(FIELDS).sort(),
    ['area-distribution', 'composition', 'ownership', 'value-change', 'value-stats']);
  // No value fields → no value-stats/value-change; no owner → no ownership.
  assert.deepEqual(CORE.supported({ area: 'a', category: 'c' }).sort(), ['area-distribution', 'composition']);
});

test('core(): assembles requested facts + honest coarse provenance (§6.4)', () => {
  const { facts, provenance } = CORE.core(INPUT);
  assert.equal(facts.cohort.count, 4);
  assert.deepEqual(facts.cohort.featureIds, [1, 2, 3, 4]);   // drill-down to contributors
  assert.ok(facts.composition && facts.valueStats && facts.valueChange && facts.ownership && facts.areaDistribution);
  assert.equal(provenance.length, 1);
  assert.equal(provenance[0].source_id, 'assessment-roll');
  assert.equal(provenance[0].anchor, '500 ft of #1');
  assert.equal(provenance[0].span, '4 features');
  assert.equal(provenance[0].state, 'coarse');           // aggregates have no single citable doc
});

test('core(): honors an explicit aggregator subset', () => {
  const { facts } = CORE.core(Object.assign({}, INPUT, { aggregators: ['composition'] }));
  assert.ok(facts.composition);
  assert.ok(!facts.valueStats && !facts.ownership);
  assert.deepEqual(facts.aggregators, ['composition']);
});

test('SOURCE-AGNOSTIC: the same core profiles a non-parcel (zoning) cohort', () => {
  const zoning = {
    cohort: { selector: { type: 'named-geography', label: 'Lockport Twp' }, features: [
      { id: 'z1', properties: { district: 'R-1', acreage: 100 } },
      { id: 'z2', properties: { district: 'R-1', acreage: 50 } },
      { id: 'z3', properties: { district: 'C-2', acreage: 30 } },
    ] },
    fields: { area: 'acreage', category: 'district' },   // different field names — config, not code
    source_id: 'zoning-ordinance',
  };
  const { facts } = CORE.core(zoning);
  assert.equal(facts.composition.categoryMix[0].key, 'R-1');
  assert.equal(facts.composition.categoryMix[0].count, 2);
  assert.ok(!facts.valueStats);   // no value fields configured → not produced
});

// ── Contract integration (the same seam the explainer/ledger use) ──────────────
test('contract: AI-off invoke yields facts, no narration (facts-parity §4.6)', async () => {
  const reg = ISV.createRegistry();
  REGISTER.registerAll(reg);
  const res = await reg.invoke('cohort-analyze', INPUT, { ai: false });
  assert.equal(res.capability, 'cohort-analyze');
  assert.equal(res.facts.cohort.count, 4);
  assert.equal(res.narration, null);
  assert.equal(res.meta.aiMode, 'ai-optional');
  assert.equal(res.meta.aiApplied, false);
});

test('contract: AI-on narrates over the facts via the injected transport', async () => {
  const reg = ISV.createRegistry();
  REGISTER.registerAll(reg);
  let sawFacts = null;
  const ctx = { fetchCohortNarration: (facts) => { sawFacts = facts; return { summary: 'Mostly residential.' }; } };
  const res = await reg.invoke('cohort-analyze', INPUT, { ai: true, ctx });
  assert.deepEqual(res.narration, { summary: 'Mostly residential.' });
  assert.equal(res.meta.aiApplied, true);
  assert.equal(sawFacts.cohort.count, 4);   // narrator only ever SEES facts (never originates)
});

test('contract: a throwing narrator degrades to facts, never errors (§4.4b)', async () => {
  const reg = ISV.createRegistry();
  REGISTER.registerAll(reg);
  const ctx = { fetchCohortNarration: () => { throw new Error('AI down'); } };
  const res = await reg.invoke('cohort-analyze', INPUT, { ai: true, ctx });
  assert.equal(res.narration, null);
  assert.equal(res.meta.degraded, true);
  assert.equal(res.facts.cohort.count, 4);   // facts still stand
});
