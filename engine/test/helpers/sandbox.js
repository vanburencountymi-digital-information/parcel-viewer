'use strict';
// Loads the viewer's files into a vm sandbox the way the page does (DIC-2180).
//
// A classic file runs as a script. A file converted to an ES module runs as a module in
// the sandbox (vm.SourceTextModule, so `npm test` passes --experimental-vm-modules), and
// its imports of shared instances (engine modules, other converted viewer files) link to
// the sandbox's window hooks, exactly as the build does on the page
// (tools/vite/module-hooks.mjs). So load files in page order, after the hooks they import.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { engineHooks, hookFor } = require('../../../tools/vite/module-hooks.mjs');

const REPO = path.resolve(__dirname, '..', '..', '..');
const ENGINE = engineHooks(REPO);

const isModule = (code) => /^(import|export) /m.test(code);

function moduleFor(sandbox, file, code) {
  return new vm.SourceTextModule(code, { context: sandbox, identifier: file });
}

// A module the importer links to: the sandbox's hook for a shared instance, or (like a
// bundled helper) its own source.
function linkTo(sandbox, file) {
  const hook = hookFor(file, ENGINE);
  if (!hook) return moduleFor(sandbox, file, fs.readFileSync(file, 'utf8'));
  if (!(hook in sandbox)) {
    throw new Error(`${path.relative(REPO, file)}: window.${hook} isn't on the sandbox yet; load what provides it first (page order)`);
  }
  return new vm.SyntheticModule(['default'], function () { this.setExport('default', sandbox[hook]); },
    { context: sandbox, identifier: file });
}

/** Runs `file` (repo-relative or absolute) in the contextified `sandbox`. */
async function loadFile(sandbox, file) {
  const abs = path.resolve(REPO, file);
  const code = fs.readFileSync(abs, 'utf8');
  if (!isModule(code)) {
    vm.runInContext(code, sandbox, { filename: abs });
    return;
  }
  if (!vm.SourceTextModule) {
    throw new Error(`${file} is an ES module: run the tests with node --experimental-vm-modules (npm test in engine/)`);
  }
  const mod = moduleFor(sandbox, abs, code);
  await mod.link((specifier, referrer) => linkTo(sandbox, path.resolve(path.dirname(referrer.identifier), specifier)));
  await mod.evaluate();
}

module.exports = { loadFile, REPO };
