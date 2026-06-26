'use strict';
// Manifest schema validation in CI (§5.2) — an invalid manifest cannot publish.
const { test } = require('node:test');
const assert = require('node:assert');

const { validate } = require('../validate-manifest.js');
const valid = require('./fixtures/manifest-valid.json');
const invalid = require('./fixtures/manifest-invalid.json');

test('a well-formed manifest validates', () => {
  const r = validate(valid);
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
});

test('an invalid manifest is rejected with actionable errors', () => {
  const r = validate(invalid);
  assert.equal(r.valid, false);
  const joined = r.errors.join(' | ');
  assert.match(joined, /missing required key: tenant/);
  assert.match(joined, /sources\[0\] missing type/);
  assert.match(joined, /capabilities\.explainer\.ai must be one of/);
});

test('the capability AI tri-state enum is enforced (§4.7)', () => {
  const m = JSON.parse(JSON.stringify(valid));
  m.capabilities.explainer.ai = 'maybe';
  assert.equal(validate(m).valid, false);
  m.capabilities.explainer.ai = 'ai-required';   // a legal tri-state value
  assert.equal(validate(m).valid, true);
});

test('the full JSON Schema file is present and well-formed (ready for C2/Ajv)', () => {
  const schema = require('../schema/manifest.schema.json');
  assert.equal(schema.title, 'ISV Theme Manifest');
  assert.ok(Array.isArray(schema.required) && schema.required.indexOf('tenant') >= 0);
});
