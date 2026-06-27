'use strict';
// Citation Renderer core (§6.4 / DIC-522). Source-agnostic: resolves a citation envelope
// against an INJECTED resolver into a render-ready result + honest degradation state. Tested
// here against a statute-corpus-backed resolver (PV) and a fake ordinance resolver (ZIP) to
// prove ONE renderer serves both — and that it never over-claims a citation.
const { test } = require('node:test');
const assert = require('node:assert');

const CITE = require('../citation.js');
const statutes = require('../data/mi-tax-statutes.json').statutes;

// A resolver over the curated MI tax-statute corpus (matches the explainer's envelope:
// source_id = citation, anchor = mcl). Whole-statute, so anchorResolved is false → coarse.
function statuteResolver(env) {
  const hit = statutes.find((s) => s.mcl === env.anchor || s.citation === env.source_id || s.name === env.span);
  if (!hit) return null;
  return { id: hit.mcl, title: hit.name, citation: hit.citation, body: hit.plain, url: hit.url,
           anchorResolved: false, state: hit.state };
}

test('resolves a real statute envelope through the injected resolver', () => {
  const env = { source_id: '1893 PA 206; MCL 211.1 et seq.', anchor: '211.1', span: 'General Property Tax Act', state: 'resolves' };
  const r = CITE.resolveCitation(env, statuteResolver);
  assert.equal(r.found, true);
  assert.equal(r.title, 'General Property Tax Act');
  assert.ok(/legislature\.mi\.gov/.test(r.url));
  assert.ok(r.body && r.body.length > 0);
  // whole-statute (anchorResolved:false) → coarse even though the corpus says 'resolves'
  assert.equal(r.state, 'coarse');
});

test('precise anchor → resolves (when the resolver confirms the passage)', () => {
  const precise = (env) => ({ id: env.anchor, title: 'Doc', body: 'full text…', anchorResolved: true, state: 'resolves' });
  const r = CITE.resolveCitation({ source_id: 'doc', anchor: 'sec-3', span: 'Section 3' }, precise);
  assert.equal(r.state, 'resolves');
  assert.equal(r.found, true);
});

test('no citable document → state "none", found false (render nothing + say so)', () => {
  const r = CITE.resolveCitation({ source_id: 'nope', anchor: 'x' }, () => null);
  assert.equal(r.found, false);
  assert.equal(r.state, 'none');
  assert.equal(r.body, null);
});

test('never over-claims: a declared "coarse" cannot be promoted to "resolves"', () => {
  const declaredCoarse = (env) => ({ id: env.anchor, title: 'D', anchorResolved: true, state: 'coarse' });
  const r = CITE.resolveCitation({ source_id: 'd', anchor: 'a' }, declaredCoarse);
  assert.equal(r.state, 'coarse');   // floored by the declared state
});

test('ONE renderer serves a different source (ZIP ordinance) unchanged', () => {
  // A fake ordinance resolver — proves source-agnosticism (zoning, not statutes).
  const ordinance = (env) => env.anchor === 'section-95-203'
    ? { id: 'section-95-203', title: 'AP — Special Land Uses', citation: 'Sec. 95.203',
        body: 'Agricultural machine sale/service…', anchorResolved: true, state: 'resolves' }
    : null;
  const r = CITE.resolveCitation({ source_id: 'zoning-95-203', anchor: 'section-95-203', span: 'Sec. 95.203' }, ordinance);
  assert.equal(r.found, true);
  assert.equal(r.state, 'resolves');
  assert.equal(r.title, 'AP — Special Land Uses');
});

test('resolveCitations keeps order and resolves each', () => {
  const out = CITE.resolveCitations(
    [{ anchor: '211.1' }, { anchor: 'does-not-exist' }],
    statuteResolver
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].found, true);
  assert.equal(out[1].state, 'none');
});
