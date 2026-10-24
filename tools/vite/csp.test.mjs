// The pages and nginx's Content-Security-Policy agree (DIC-2556). Run: npm run test:build
//
// script-src is 'self' only, so the pages may have no inline <script> and no inline event
// handlers (onerror=, onclick=, ...): the browser would report (and, enforced, skip) them.
// The e2e suite fails on any violation at runtime; this catches the static ones at once.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const PAGES = ['demo/index.html', 'admin/index.html'];

const policy = (() => {
  const conf = read('infra/nginx.viewer.conf');
  const vars = {};
  for (const m of conf.matchAll(/map \$host \$(\w+) \{\s*default "([^"]*)";/g)) vars[m[1]] = m[2];
  return vars.pv_csp.replace(/\$(\w+)/g, (_, name) => vars[name]);
})();
const directive = (name) => policy.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name)?.slice(1);

test('script-src allows no inline script or eval', () => {
  assert.deepEqual(directive('script-src'), ["'self'"]);
});

test('the policy reports to the API sink', () => {
  assert.deepEqual(directive('report-uri'), ['/api/csp-report']);
});

/** The page without its comments (removed until none are left, so none can hide a tag). */
function withoutComments(html) {
  for (let prev; prev !== html;) {
    prev = html;
    html = html.replace(/<!--[\s\S]*?-->/g, '');
  }
  return html;
}

for (const page of PAGES) {
  const html = withoutComments(read(page));

  test(`${page} has no inline scripts`, () => {
    const inline = [...html.matchAll(/<script\b([^>]*)>/gi)].filter(([, attrs]) => !/\ssrc=/i.test(attrs));
    assert.deepEqual(inline.map(([tag]) => tag), []);
  });

  test(`${page} has no inline event handlers`, () => {
    assert.deepEqual(html.match(/<[a-z][^>]*\son[a-z]+\s*=/gi) || [], []);
  });
}

test("connect-src allows the county config's Map Buddy service", () => {
  const origins = [
    ...read('frontend/public/js/county-config.js').matchAll(/mapBuddy:\s*"([^"]+)"/g),
    ...read('engine/themes/vanburen.json').matchAll(/"(?:mapBuddy|apiBase)":\s*"(https:[^"]+)"/g),
  ].map(([, url]) => new URL(url).origin);
  assert.ok(origins.length >= 2, 'found the Map Buddy URLs');
  for (const origin of origins) assert.ok(directive('connect-src').includes(origin), `${origin} in connect-src`);
});
