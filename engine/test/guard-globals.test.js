'use strict';
// Guard against the global-singleton bus creeping back in (A3 / DIC-568). The engine
// layer must NEVER read or write a `window.PS_*` / `window.ZIP_*` global — new code
// goes through the injected AppContext. This is the lint/guard the spec calls for,
// enforced in CI over the engine source. (Domain bridges like
// frontend/public/js/pv-app-context.js are the sanctioned place for PS_* names.)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ENGINE = path.join(__dirname, '..');

function engineSourceFiles() {
  const out = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (name === 'test' || name === 'node_modules') continue;   // tests/deps excluded
        walk(p);
      } else if (name.endsWith('.js')) {
        out.push(p);
      }
    }
  })(ENGINE);
  return out;
}

test('no engine file references a PS_* / ZIP_* global-bus singleton', () => {
  const offenders = [];
  for (const file of engineSourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    const m = src.match(/\b(PS_[A-Z]|ZIP_[A-Z])\w*/g);
    if (m) offenders.push(path.relative(ENGINE, file) + ' → ' + Array.from(new Set(m)).join(', '));
  }
  assert.deepEqual(offenders, [], 'engine code must use the injected AppContext, not global singletons:\n' + offenders.join('\n'));
});

test('the guard actually has files to check (it is not vacuously passing)', () => {
  assert.ok(engineSourceFiles().length >= 6, 'expected the engine to have several source files');
});
