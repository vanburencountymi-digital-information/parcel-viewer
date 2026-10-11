// npm run test:build  (DIC-2180 slice 2b)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { bundle, checkFile, decodeMappings, findRuns, isModule, loadFile } from './classic-scripts.mjs';

const repo = resolve(import.meta.dirname, '../..');

test('findRuns bundles only runs of 2+ local classic scripts', () => {
  const html = `
    <script src="/a.js"></script>
    <!-- a comment between tags stays inside the run -->
    <script src="/b.js"></script>
    <script>inline()</script>
    <script src="/lone.js"></script>
    <script src="/api/config.js" onerror="x()"></script>
    <script src="/c.js"></script>
    <script src="https://cdn.example/lib.js"></script>
    <script src="/d.js"></script>
    <script src="/e.js" defer></script>
    <script type="module" src="/f.js"></script>
    <script src="/g.js"></script>
    <script src="/h.js"></script>`;
  assert.deepEqual(findRuns(html).map((r) => r.srcs), [['/a.js', '/b.js'], ['/g.js', '/h.js']]);
});

test('checkFile accepts a single IIFE and rejects what a block would change', () => {
  checkFile('ok.js', "(function (root) { 'use strict'; root.X = 1; })(window);");
  checkFile('var.js', 'var shared = 1;');
  for (const [code, what] of [
    ['let a = 1;', /top-level let/],
    ['const a = 1;', /top-level const/],
    ['class A {}', /top-level class/],
    ['function f() {}', /top-level function/],
    ["'use strict';\nx = 1;", /file-level 'use strict'/],
    ['(function () {', /does not parse/],
  ]) {
    assert.throws(() => checkFile('bad.js', code), what);
  }
});

function run(code) {
  const reported = [];
  const window = { reportError: (e) => reported.push(e.message) };
  window.window = window;
  vm.runInNewContext(code, window);
  return { window, reported };
}

test('the bundle keeps globals shared and isolates a throwing file', () => {
  const { code } = bundle([
    { src: '/one.js', code: '(function (root) { root.ONE = 1; })(window);' },
    { src: '/boom.js', code: '(function () { throw new Error("boom"); })();\n' },
    { src: '/two.js', code: 'var TWO = window.ONE + 1; // no trailing newline' },
  ]);
  const { window, reported } = run(code);
  assert.equal(window.ONE, 1);
  assert.equal(window.TWO, 2, 'a top-level var is still a global, and boom.js did not stop two.js');
  assert.deepEqual(reported, ['boom']);
});

test('the source map points each code line back to its file and line', () => {
  const { code, map } = bundle([
    { src: '/one.js', code: 'a();\nb();' },
    { src: '/two.js', code: '﻿c();\r\nd();\r\n' },
  ]);
  const lines = code.split('\n');
  const segs = map.mappings.split(';');
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const decode = (s) => {
    const out = [];
    let v = 0, shift = 0;
    for (const ch of s) {
      const d = B64.indexOf(ch);
      v += (d & 31) << shift;
      if (d & 32) { shift += 5; continue; }
      out.push(v & 1 ? -(v >> 1) : v >> 1);
      v = 0; shift = 0;
    }
    return out;
  };
  let src = 0, line = 0;
  const found = {};
  segs.forEach((seg, i) => {
    if (!seg) return;
    const [, ds, dl] = decode(seg);
    src += ds; line += dl;
    found[lines[i]] = `${map.sources[src]}:${line + 1}`;
  });
  assert.deepEqual(found, { 'a();': '/one.js:1', 'b();': '/one.js:2', 'c();': '/two.js:1', 'd();': '/two.js:2' });
});

test("every script the pages bundle today passes the build's checks", async () => {
  for (const page of ['demo/index.html', 'admin/index.html']) {
    const runs = findRuns(readFileSync(resolve(repo, page), 'utf8'));
    assert.ok(runs.length >= 2, page);
    for (const src of runs.flatMap((r) => r.srcs)) {
      assert.notEqual(src, '/api/config.js');
      await loadFile(repo, src); // classic files are checked; ES module entries bundled, then checked
    }
  }
});

test('an ES module entry is bundled into a classic IIFE that joins its run', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'pv-classic-'));
  try {
    writeFileSync(resolve(dir, 'dep.js'), 'const mod = { n: 41 };\nexport { mod as default };\n');
    writeFileSync(resolve(dir, 'entry.js'), "import dep from './dep.js';\n\nwindow.HOOK = dep.n + 1;\n");
    writeFileSync(resolve(dir, 'after.js'), '(function () { window.AFTER = window.HOOK; })();\n');
    assert.ok(isModule(readFileSync(resolve(dir, 'entry.js'), 'utf8')));
    assert.ok(!isModule(readFileSync(resolve(dir, 'after.js'), 'utf8')));

    const files = [await loadFile(dir, '/entry.js'), await loadFile(dir, '/after.js')];
    assert.deepEqual(files[0].map.sources.sort(), ['/dep.js', '/entry.js']);
    const { code, map } = bundle(files);
    const { window } = run(code);
    assert.equal(window.HOOK, 42);
    assert.equal(window.AFTER, 42, 'the entry ran synchronously, before the next file');

    // The bundle's map sends the entry's lines to the original modules.
    const lines = code.split('\n');
    const found = new Set();
    decodeMappings(map.mappings).forEach((segs, i) => segs.forEach(([, s]) => {
      if (/HOOK = /.test(lines[i])) found.add(map.sources[s]);
    }));
    assert.ok(found.has('/entry.js'), 'the hook line maps to entry.js');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a throwing ES module entry stops only itself', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'pv-classic-'));
  try {
    writeFileSync(resolve(dir, 'boom.js'), "import './dep.js';\nthrow new Error('entry boom');\n");
    writeFileSync(resolve(dir, 'dep.js'), 'window.DEP = 1;\nexport {};\n');
    writeFileSync(resolve(dir, 'after.js'), '(function () { window.AFTER = 1; })();\n');
    const { code } = bundle([await loadFile(dir, '/boom.js'), await loadFile(dir, '/after.js')]);
    const { window, reported } = run(code);
    assert.deepEqual([window.DEP, window.AFTER, reported], [1, 1, ['entry boom']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an entry importing a shared instance reads its window hook instead of bundling a copy', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'pv-classic-'));
  try {
    mkdirSync(resolve(dir, 'engine'));
    // An engine module (named in window-hooks.js) and a converted viewer module (its own hook).
    writeFileSync(resolve(dir, 'engine/core.js'), 'const mod = { calls: 0 };\nexport { mod as default };\n');
    writeFileSync(resolve(dir, 'engine/window-hooks.js'), "import ISV_CORE from './core.js';\nexport const viewerHooks = { ISV_CORE };\n");
    writeFileSync(resolve(dir, 'engine/browser.js'), "import { viewerHooks } from './window-hooks.js';\nObject.assign(window, viewerHooks);\n");
    writeFileSync(resolve(dir, 'shared.js'), 'const PV_SHARED = { made: 1 };\n\nglobalThis.PV_SHARED = PV_SHARED;\nexport default PV_SHARED;\n');
    writeFileSync(resolve(dir, 'user.js'),
      "import PV_SHARED from './shared.js';\nimport ISV_CORE from './engine/core.js';\n\n" +
      'ISV_CORE.calls++;\nwindow.SAME = PV_SHARED === window.PV_SHARED && ISV_CORE === window.ISV_CORE;\n');

    const files = [];
    for (const src of ['/engine/browser.js', '/shared.js', '/user.js']) files.push(await loadFile(dir, src));
    assert.doesNotMatch(files[2].code, /made: 1|calls: 0/, 'user.js bundles no copy of either module');
    const { window, reported } = run(bundle(files).code);
    assert.deepEqual(reported, []);
    assert.equal(window.SAME, true, 'user.js got the instances already on the page');
    assert.equal(window.ISV_CORE.calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the viewer keeps county-config.js as its own tag just before /api/config.js', () => {
  const html = readFileSync(resolve(repo, 'demo/index.html'), 'utf8');
  const srcs = findRuns(html).flatMap((r) => r.srcs);
  assert.ok(!srcs.includes('/frontend/public/js/county-config.js'));
  assert.match(html, /<script src="\/frontend\/public\/js\/county-config\.js"><\/script>\s*<script src="\/api\/config\.js"/);
});
