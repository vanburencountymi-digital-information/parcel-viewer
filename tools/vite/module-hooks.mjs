// Which modules are shared instances on the page, and under which window name (DIC-2180).
//
// While the viewer moves to ES modules file by file, each converted file stays its own
// entry on the page (its own place in the load order, its own try/catch). So an import of
// another module must not bundle a second copy of it: the importer gets the one instance
// already on the page, through its window hook. The rule, used by the build plugin
// (classic-scripts.mjs) and the harness's sandbox loader (engine/test/helpers):
//
//   - an engine module's hook is the name engine/window-hooks.js imports it as;
//   - a viewer module provides a hook by ending with `globalThis.NAME = NAME;` (its own
//     name, at the top level), which the page's classic scripts and the tests also read.
//
// Plain regexes over that fixed shape, so the zero-dependency harness can use this too.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const VIEWER_HOOK = /^globalThis\.([A-Z][A-Z0-9_]*) = \1;$/m;
const ENGINE_IMPORT = /^import (ISV[A-Z0-9_]*) from '(\.[^']+)';$/gm;

/** The hook a viewer module's source provides, or null. */
export function hookOf(code) {
  const m = VIEWER_HOOK.exec(code.replace(/\r\n/g, '\n'));
  return m ? m[1] : null;
}

/** Map of absolute engine file path -> hook name, from engine/window-hooks.js. */
export function engineHooks(root) {
  const file = resolve(root, 'engine/window-hooks.js');
  const map = new Map();
  if (!existsSync(file)) return map; // a project (or test folder) with no engine hooks
  const code = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [, name, rel] of code.matchAll(ENGINE_IMPORT)) map.set(resolve(dirname(file), rel), name);
  return map;
}

/**
 * The hook `file` provides (an engine module, or a viewer module by its own source), or
 * null. `engine` is engineHooks(root), passed in so callers read window-hooks.js once.
 */
export function hookFor(file, engine) {
  if (engine.has(file)) return engine.get(file);
  try {
    return hookOf(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
