'use strict';
// Canonical tenant key + tenant→DB-county mapping (ISV keystone, DIC-582). The single owner
// of the tenant spelling: manifest.tenant is canonical (`vanburen`); engine/tenant.js maps it
// to the DB `county` code RLS keys on (`VBC`). Fail-closed on unknown tenants.
const { test } = require('node:test');
const assert = require('node:assert');

const TENANT = require('../tenant.js');

test('canonicalTenant reads manifest.tenant', () => {
  assert.equal(TENANT.canonicalTenant({ tenant: 'vanburen' }), 'vanburen');
  assert.equal(TENANT.canonicalTenant({ tenant: '  vanburen  ' }), 'vanburen');  // trimmed
});

test('canonicalTenant → null when absent', () => {
  assert.equal(TENANT.canonicalTenant({}), null);
  assert.equal(TENANT.canonicalTenant(null), null);
  assert.equal(TENANT.canonicalTenant({ tenant: '' }), null);
});

test('dbCounty maps the canonical key to the DB county code', () => {
  assert.equal(TENANT.dbCounty('vanburen'), 'VBC');
});

test('dbCounty → null (fail-closed) for unknown/empty tenant', () => {
  assert.equal(TENANT.dbCounty('not-a-county'), null);   // unknown → null, never "all"
  assert.equal(TENANT.dbCounty(''), null);
  assert.equal(TENANT.dbCounty(null), null);
  // the old name-slug is NOT canonical and resolves to nothing
  assert.equal(TENANT.dbCounty('van-buren-county'), null);
});

test('register adds a new tenant→county mapping', () => {
  TENANT.register('sjc', 'SJC');
  assert.equal(TENANT.dbCounty('sjc'), 'SJC');
  assert.throws(() => TENANT.register('x', ''));   // both required
  assert.throws(() => TENANT.register('', 'Y'));
});

test('the canonical tenant resolves end-to-end from a manifest', () => {
  const manifest = { tenant: 'vanburen' };
  const key = TENANT.canonicalTenant(manifest);
  assert.equal(TENANT.dbCounty(key), 'VBC');   // manifest → canonical → DB county
});
