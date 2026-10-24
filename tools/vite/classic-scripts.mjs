// Bundles the pages' <script src> files into classic scripts at build time (DIC-2180).
//
// Vite only bundles type="module" scripts, and loading the app as modules would change
// behaviour: modules run after parsing (about 15 files rely on running while
// document.readyState is still "loading"), and one throwing module stops the rest. So this
// plugin keeps the page classic. Each run of two or more consecutive local scripts becomes
// ONE classic script in /assets/ (content-hashed, with a source map):
//
//   - order and timing: the bundle sits where the run was and runs synchronously, so every
//     inline script, CDN library and /api/config.js keeps its place between the runs;
//   - shared globals: each file's code goes in a block, not a function, so a top-level
//     `var` is still a global. That holds only while files have no top-level
//     let/const/class/function or 'use strict' (a block would scope or drop them), which
//     the build checks: today every file is a single IIFE or UMD statement;
//   - error isolation: each block has its own try/catch that hands the error to
//     window.reportError, so a throwing file stops only itself, and the error still
//     reaches window 'error' listeners (pv-error-beacon.js) as an uncaught one would;
//   - syntax errors: each file is parsed on its own first, and the build fails on one,
//     where the browser used to skip just that file.
//
// ES modules (slice 3): a tag whose file uses import/export (e.g. /engine/browser.js) is an
// entry. Rolldown bundles it and everything it imports into one IIFE, which then joins
// its run like any classic file: same place, same synchronous timing, its own try/catch
// (so the isolation unit is the entry, not each module it imports). Its source map points
// at the original modules. An import of a module that is already a shared instance on the
// page (the engine's, or another converted viewer file's) reads its window hook instead of
// bundling a copy (see module-hooks.mjs).
//
// Left alone: module/async/defer scripts, scripts with any attribute besides src, remote
// and /api/ URLs (/api/config.js), and a lone local app script (so the
// baked county-config.js stays its own tag just before /api/config.js). Libraries from
// /node_modules/ (MapLibre, Turf, proj4) always get bundles of their own. Build only; the dev
// stack serves this build too (`npm run dev` = `vite build --watch`, on the host).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { rolldown } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';
import { engineHooks, hookFor } from './module-hooks.mjs';

// The folders the pages load scripts from, watched in `vite build --watch`: this plugin
// reads those files itself, so Vite wouldn't otherwise know a change needs a rebuild.
const SCRIPT_DIRS = ['frontend/public/js', 'engine', 'admin/js', 'map-buddy/js', 'vendor'];

// A run of <script src="/local.js"></script> tags separated only by whitespace and comments.
const SCRIPT_TAG = /<script\s+src="(\/[^"]*)"\s*><\/script>/y;
const GAP = /(?:\s|<!--[\s\S]*?-->)*/y;

function bundleable(src) {
  return src.startsWith('/') && !src.startsWith('//') && !src.startsWith('/api/');
}

// Third-party libraries come from node_modules (slice 4) as their packages' prebuilt files,
// or through a small entry in vendor/ when the package is ES modules only (MapLibre 6,
// DIC-2379). They get runs (so bundles) of their own: a library bundle only changes with a
// version bump, so it stays cached across app releases. nginx never serves /node_modules/
// or /vendor/, so even a lone library tag is bundled.
const isLibrary = (src) => src.startsWith('/node_modules/') || src.startsWith('/vendor/');

/** Finds runs of bundleable script tags: [{ start, end, srcs }]. */
export function findRuns(html) {
  const runs = [];
  const opener = /<script\s+src="/g;
  let m;
  while ((m = opener.exec(html))) {
    const srcs = [];
    let pos = m.index;
    let end = pos;
    for (;;) {
      SCRIPT_TAG.lastIndex = pos;
      const tag = SCRIPT_TAG.exec(html);
      if (!tag || !bundleable(tag[1])) break;
      if (srcs.length && isLibrary(tag[1]) !== isLibrary(srcs[0])) break;
      srcs.push(tag[1]);
      end = SCRIPT_TAG.lastIndex;
      GAP.lastIndex = end;
      GAP.exec(html);
      pos = GAP.lastIndex;
    }
    if (srcs.length >= 2 || (srcs.length && isLibrary(srcs[0]))) runs.push({ start: m.index, end, srcs });
    opener.lastIndex = Math.max(end, m.index + 1);
  }
  return runs;
}

/** True when `code` uses import/export, i.e. it is an entry for Rolldown to bundle. */
export function isModule(code) {
  let ast;
  try {
    ast = parseAst(code, { sourceType: 'module', lang: 'js' });
  } catch {
    return false;
  }
  return ast.body.some((n) => /^(Import|Export)/.test(n.type));
}

/** Throws unless `code` is safe to run inside a block of a shared classic bundle. */
export function checkFile(src, code) {
  let ast;
  try {
    ast = parseAst(code, { sourceType: 'script', lang: 'js' }, src);
  } catch (err) {
    throw new Error(`${src}: does not parse as a classic script: ${err.message}`);
  }
  for (const node of ast.body) {
    const what =
      node.type === 'VariableDeclaration' && node.kind !== 'var' ? `top-level ${node.kind}` :
      node.type === 'ClassDeclaration' ? 'top-level class' :
      node.type === 'FunctionDeclaration' ? 'top-level function' :
      node.type === 'ExpressionStatement' && node.directive === 'use strict' ? "file-level 'use strict'" :
      null;
    if (what) {
      throw new Error(
        `${src}: ${what} can't be bundled as a classic script (it would no longer be ` +
        'shared, or strict, once wrapped in a block); wrap the file in an IIFE ' +
        '(see tools/vite/classic-scripts.mjs)',
      );
    }
  }
}

// ── Source maps (VLQ mappings as arrays of absolute [column, source, line, column]) ──
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function vlq(n) {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v) digit |= 32;
    out += B64[digit];
  } while (v);
  return out;
}

/** Decodes a mappings string into lines of absolute [genCol, source, line, col] segments. */
export function decodeMappings(mappings) {
  let source = 0, line = 0, col = 0;
  return mappings.split(';').map((group) => {
    let genCol = 0;
    return group.split(',').filter(Boolean).map((seg) => {
      const f = [];
      let v = 0, shift = 0;
      for (const ch of seg) {
        const d = B64.indexOf(ch);
        v += (d & 31) << shift;
        if (d & 32) { shift += 5; continue; }
        f.push(v & 1 ? -(v >>> 1) : v >>> 1);
        v = 0; shift = 0;
      }
      genCol += f[0];
      if (f.length < 4) return null; // a segment with no source position
      source += f[1]; line += f[2]; col += f[3];
      return [genCol, source, line, col];
    }).filter(Boolean);
  });
}

function encodeMappings(lines) {
  let source = 0, line = 0, col = 0;
  return lines.map((segs) => {
    let genCol = 0;
    return segs.map(([g, s, l, c]) => {
      const out = vlq(g - genCol) + vlq(s - source) + vlq(l - line) + vlq(c - col);
      genCol = g; source = s; line = l; col = c;
      return out;
    }).join(',');
  }).join(';');
}

/**
 * Concatenates the files into one classic script. Returns { code, map }. A file is
 * { src, code } (each of its lines maps to the same line of `src`) or, for a bundled
 * entry, { src, code, map } (its own map, merged in, pointing at the original modules).
 */
export function bundle(files) {
  const lines = [];
  const segments = [];
  const sources = [];
  const sourcesContent = [];
  const sourceIndex = (s, content) => {
    const i = sources.indexOf(s);
    if (i >= 0) return i;
    sourcesContent.push(content ?? null);
    return sources.push(s) - 1;
  };
  const pushWrapper = (line) => { lines.push(line); segments.push([]); };
  for (const { src, code, map } of files) {
    const body = code.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    const own = map ? decodeMappings(map.mappings) : null;
    const remap = map ? map.sources.map((s, i) => sourceIndex(s, map.sourcesContent?.[i])) : null;
    const self = map ? -1 : sourceIndex(src, code);
    pushWrapper(`// ${src}`);
    pushWrapper('try {');
    body.forEach((line, i) => {
      lines.push(line);
      segments.push(own
        ? (own[i] || []).map(([g, s, l, c]) => [g, remap[s], l, c])
        : [[0, self, i, 0]]);
    });
    pushWrapper('} catch (e) { if (window.reportError) window.reportError(e); else setTimeout(function () { throw e; }); }');
  }
  return {
    code: lines.join('\n') + '\n',
    // sourcesContent: devtools shows the original files without fetching them by path.
    map: { version: 3, sources, sourcesContent, names: [], mappings: encodeMappings(segments) },
  };
}

/** The URL path of a file under `root` (what the page and source maps call it). */
function urlPath(root, file) {
  return '/' + relative(root, file).split('\\').join('/');
}

/**
 * Reads one script of a run: a classic file as is, or an ES module entry bundled by
 * Rolldown into a classic IIFE with its own source map. Both are checked for bundling.
 */
export async function loadFile(root, src) {
  const file = resolve(root, '.' + src);
  const code = readFileSync(file, 'utf8');
  if (!isModule(code)) {
    checkFile(src, code);
    return { src, code };
  }
  const assets = [];
  const library = isLibrary(src);
  const build = await rolldown({
    input: file, cwd: root, logLevel: 'warn', plugins: [sharedInstances(root), assetUrls(assets)],
    // A library entry (vendor/) bundles a package's ES build, which may read import.meta.url
    // as a fallback the entry overrides (MapLibre's worker URL). There is no import.meta in a
    // classic script; say so explicitly instead of warning on every build.
    ...(library ? { transform: { define: { 'import.meta': '{}' } } } : {}),
  });
  try {
    // dir: root, so the map's sources are relative to the root (generate() writes nothing).
    const { output: [chunk] } = await build.generate({
      format: 'iife', sourcemap: true, dir: root,
      // Libraries ship minified; re-printing them unminified would add ~0.6 MB. App code
      // keeps Rolldown's default (not minified, so devtools shows it as written); an
      // explicit `minify: false` would also turn off its dead-code removal.
      ...(library ? { minify: true } : {}),
      globals: (id) => (id.startsWith(HOOK_ID) ? `globalThis.${id.slice(HOOK_ID.length)}` : undefined),
    });
    const out = chunk.code.replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n');
    checkFile(src, out);
    const sources = chunk.map.sources.map((s) => urlPath(root, isAbsolute(s) ? s : resolve(root, s)));
    return { src, code: out, assets, map: { sources, sourcesContent: chunk.map.sourcesContent, mappings: chunk.map.mappings } };
  } finally {
    await build.close();
  }
}

// An import of a module that is a shared instance on the page (tools/vite/module-hooks.mjs)
// is left out of the bundle and read from its window hook, so every entry uses the one
// instance (e.g. one capability registry). Imports inside the engine stay bundled: the
// engine entry is what creates those instances.
const HOOK_ID = 'pv-hook:';
function sharedInstances(root) {
  const engineDir = resolve(root, 'engine') + sep;
  const engine = engineHooks(root);
  return {
    name: 'pv-shared-instances',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.') || importer.startsWith(engineDir)) return null;
      const target = resolve(dirname(importer), source);
      const hook = hookFor(target, engine);
      return hook ? { id: HOOK_ID + hook, external: true } : null;
    },
  };
}

// `import url from './file?url'` (as in Vite): the file is published as-is in /assets/,
// content-hashed, and the import is its path. MapLibre 6's worker comes in this way: the
// worker must be its own file, and the bundle can't find it through import.meta.url.
const URL_QUERY = '?url';
function assetUrls(assets) {
  return {
    name: 'pv-asset-urls',
    async resolveId(source, importer) {
      if (!source.endsWith(URL_QUERY)) return null;
      const target = await this.resolve(source.slice(0, -URL_QUERY.length), importer, { skipSelf: true });
      return target ? { id: target.id + URL_QUERY } : null;
    },
    load(id) {
      if (!id.endsWith(URL_QUERY)) return null;
      const file = id.slice(0, -URL_QUERY.length);
      const source = readFileSync(file);
      const hash = createHash('sha256').update(source).digest('base64url').slice(0, 8);
      // .js, not .mjs: nginx's mime.types may not know .mjs, and a module worker needs a
      // JavaScript MIME type.
      const fileName = `assets/${basename(file).replace(/\.m?js$/, '')}-${hash}.js`;
      assets.push({ fileName, source });
      return `export default ${JSON.stringify('/' + fileName)};`;
    },
  };
}

function scriptFiles(root) {
  return SCRIPT_DIRS.flatMap((dir) =>
    readdirSync(resolve(root, dir), { recursive: true })
      .filter((f) => f.endsWith('.js') && !/(^|[\\/])(test|node_modules)[\\/]/.test(f))
      .map((f) => join(root, dir, f)));
}

export default function classicScripts({ root }) {
  const emitted = new Map(); // fileName -> source
  return {
    name: 'pv-classic-scripts',
    apply: 'build',
    buildStart() {
      emitted.clear();
      for (const file of scriptFiles(root)) this.addWatchFile(file);
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(html) {
        const runs = findRuns(html);
        let out = '';
        let last = 0;
        for (const run of runs) {
          const files = [];
          for (const src of run.srcs) files.push(await loadFile(root, src));
          for (const { fileName, source } of files.flatMap((f) => f.assets || [])) emitted.set(fileName, source);
          const { code, map } = bundle(files);
          const hash = createHash('sha256').update(code).digest('base64url').slice(0, 8);
          // Named by content only, so pages loading the same run share one cached file.
          const name = `scripts-${hash}.js`;
          emitted.set(`assets/${name}`, `${code}//# sourceMappingURL=${name}.map\n`);
          emitted.set(`assets/${name}.map`, JSON.stringify({ ...map, file: name }));
          const list = run.srcs.map((s) => `     ${s}`).join('\n');
          out += html.slice(last, run.start) +
            `<!-- Bundled at build time (tools/vite/classic-scripts.mjs), in this order:\n${list} -->\n  ` +
            `<script vite-ignore src="/assets/${name}"></script>`;
          last = run.end;
        }
        return out + html.slice(last);
      },
    },
    generateBundle() {
      for (const [fileName, source] of emitted) this.emitFile({ type: 'asset', fileName, source });
    },
  };
}
