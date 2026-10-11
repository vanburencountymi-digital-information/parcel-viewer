// Bundles the pages' classic <script src> files at build time (DIC-2180 slice 2b).
//
// Vite only bundles type="module" scripts, and turning the app's scripts into modules
// would change behaviour: modules run after parsing (about 15 files rely on running while
// document.readyState is still "loading"), and one throwing module stops the rest. So this
// plugin keeps them classic. Each run of two or more consecutive local classic scripts
// becomes ONE classic script in /assets/ (content-hashed, with a source map):
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
// Left alone: module/async/defer scripts, scripts with any attribute besides src (e.g.
// /api/config.js's onerror), remote and /api/ URLs, and a lone local script (so the baked
// county-config.js stays its own tag just before /api/config.js). Build only; the dev
// stack keeps serving the source files.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAst } from 'rolldown/parseAst';

// A run of <script src="/local.js"></script> tags separated only by whitespace and comments.
const SCRIPT_TAG = /<script\s+src="(\/[^"]*)"\s*><\/script>/y;
const GAP = /(?:\s|<!--[\s\S]*?-->)*/y;

function bundleable(src) {
  return src.startsWith('/') && !src.startsWith('//') && !src.startsWith('/api/');
}

/** Finds runs of bundleable classic script tags: [{ start, end, srcs }]. */
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
      srcs.push(tag[1]);
      end = SCRIPT_TAG.lastIndex;
      GAP.lastIndex = end;
      GAP.exec(html);
      pos = GAP.lastIndex;
    }
    if (srcs.length >= 2) runs.push({ start: m.index, end, srcs });
    opener.lastIndex = Math.max(end, m.index + 1);
  }
  return runs;
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

/**
 * Concatenates the files into one classic script. Returns { code, map }: `map` is a
 * line-level source map (every generated line of a file's code maps to the same line of
 * that file; wrapper lines map to nothing).
 */
export function bundle(files) {
  const lines = [];
  const mappings = [];
  let prevSource = 0;
  let prevLine = 0;
  const pushWrapper = (line) => { lines.push(line); mappings.push(''); };
  files.forEach(({ src, code }, sourceIndex) => {
    const body = code.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    pushWrapper(`// ${src}`);
    pushWrapper('try {');
    body.forEach((line, i) => {
      lines.push(line);
      mappings.push(vlq(0) + vlq(sourceIndex - prevSource) + vlq(i - prevLine) + vlq(0));
      prevSource = sourceIndex;
      prevLine = i;
    });
    pushWrapper('} catch (e) { if (window.reportError) window.reportError(e); else setTimeout(function () { throw e; }); }');
  });
  return {
    code: lines.join('\n') + '\n',
    map: { version: 3, sources: files.map((f) => f.src), names: [], mappings: mappings.join(';') },
  };
}

export default function classicScripts({ root }) {
  const emitted = new Map(); // fileName -> source
  return {
    name: 'pv-classic-scripts',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const runs = findRuns(html);
        let out = '';
        let last = 0;
        runs.forEach((run) => {
          const files = run.srcs.map((src) => {
            const code = readFileSync(resolve(root, '.' + src), 'utf8');
            checkFile(src, code);
            return { src, code };
          });
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
        });
        return out + html.slice(last);
      },
    },
    generateBundle() {
      for (const [fileName, source] of emitted) this.emitFile({ type: 'asset', fileName, source });
    },
  };
}
