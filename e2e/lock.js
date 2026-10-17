// Machine-wide lock so full e2e runs take turns (DIC-2436).
//
// Several sessions share one machine. Two full suites at once starve each other's headless
// browsers of CPU and turn into dozens of bogus 60 s timeouts, so a full run takes a lock file
// in the OS temp folder first. A run that finds the lock waits, saying which run holds it.
// The holder rewrites its heartbeat every HEARTBEAT_MS; a lock whose pid is gone, or whose
// heartbeat stopped, was left by a crashed run and is cleared.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const HEARTBEAT_MS = 30_000;
const STALE_MS = 5 * 60_000;            // no heartbeat for this long = the holder is gone
const POLL_MS = 15_000;
const REMIND_MS = 5 * 60_000;

function lockPath() {
  return process.env.E2E_LOCK_FILE || path.join(os.tmpdir(), 'parcel-viewer-e2e.lock');
}

// Playwright CLI flags that take a value as the next argument (so it isn't a file filter).
const VALUE_FLAGS = new Set([
  '-c', '--config', '-g', '--grep', '--grep-invert', '--project', '--output', '--reporter',
  '-j', '--workers', '--timeout', '--retries', '--repeat-each', '--max-failures', '--shard',
  '--trace', '--tsconfig', '--global-timeout', '--update-snapshots', '-u', '--browser',
  '--test-list', '--test-list-invert', '--only-changed',
]);
const TARGETED_FLAGS = ['-g', '--grep', '--grep-invert', '--last-failed', '--only-changed', '--test-list'];

// Is this a full-suite run? Spec-file filters, --grep and --last-failed are targeted runs,
// which sessions use while developing; they don't take the lock. E2E_LOCK=1 / 0 overrides.
function isFullRun(argv = process.argv, env = process.env) {
  if (env.E2E_LOCK === '1') return true;
  if (env.E2E_LOCK === '0') return false;
  const i = argv.indexOf('test');
  const args = i >= 0 ? argv.slice(i + 1) : [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const flag = a.split('=')[0];
    if (TARGETED_FLAGS.includes(flag)) return false;
    if (a.startsWith('-')) {
      // --update-snapshots and --only-changed take an optional value; only skip a value that
      // isn't itself a flag.
      if (!a.includes('=') && VALUE_FLAGS.has(a) && args[k + 1] && !args[k + 1].startsWith('-')) k++;
      continue;
    }
    return false;                        // a positional argument filters spec files
  }
  return true;
}

function gitBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readLock(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const mtime = (() => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } })();
  try { return { ...JSON.parse(text), mtime }; } catch { return { token: null, corrupt: true, mtime }; }
}

// Why a lock is stale, or null if its holder looks alive.
function staleReason(lock, now = Date.now(), alive = pidAlive) {
  if (lock.corrupt) return now - lock.mtime > STALE_MS ? 'unreadable and old' : null;
  const sameHost = !lock.host || lock.host === os.hostname();
  if (sameHost && !alive(lock.pid)) return `its process (pid ${lock.pid}) has exited`;
  const beat = Math.max(lock.heartbeat || 0, lock.mtime || 0);
  if (now - beat > STALE_MS) return `no heartbeat for ${Math.round((now - beat) / 60_000)} min`;
  return null;
}

function minutes(ms) {
  return ms < 60_000 ? 'under a minute' : `${Math.round(ms / 60_000)} min`;
}

function describe(lock, now = Date.now()) {
  if (lock.corrupt) return 'an unreadable lock';
  const parts = [`pid ${lock.pid}`];
  if (lock.branch) parts.push(`branch ${lock.branch}`);
  if (lock.cwd) parts.push(`in ${lock.cwd}`);
  if (lock.baseURL) parts.push(`against ${lock.baseURL}`);
  if (lock.startedAt) parts.push(`running ${minutes(now - Date.parse(lock.startedAt))}`);
  return parts.join(', ');
}

// Move a stale lock aside. Rename is atomic, so of two waiters only one removes it; if the
// file we moved isn't the stale one we saw (someone took the lock in between), put it back.
function clearStale(file, seen) {
  const aside = `${file}.stale-${process.pid}-${Date.now()}`;
  try { fs.renameSync(file, aside); } catch { return; }
  const moved = readLock(aside);
  if (moved && moved.token !== seen.token) {
    try { fs.linkSync(aside, file); } catch { /* the slot is taken again; let it be */ }
  }
  try { fs.unlinkSync(aside); } catch { /* already gone */ }
}

function tryCreate(file, info) {
  try {
    fs.writeFileSync(file, JSON.stringify(info, null, 2), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for the lock, take it, and return a release function.
async function acquire({
  file = lockPath(), baseURL, log = console.log,
  pollMs = POLL_MS, remindMs = REMIND_MS, heartbeatMs = HEARTBEAT_MS,
  timeoutMs = Number(process.env.E2E_LOCK_TIMEOUT_MIN || 120) * 60_000,
} = {}) {
  const info = {
    token: crypto.randomUUID(),
    pid: process.pid,
    host: os.hostname(),
    cwd: process.cwd(),
    branch: gitBranch(process.cwd()),
    baseURL: baseURL || null,
    startedAt: new Date().toISOString(),
    heartbeat: Date.now(),
  };
  const began = Date.now();
  let lastSaid = 0;
  let lastHolder = null;
  for (;;) {
    if (tryCreate(file, info)) break;
    const held = readLock(file);
    if (!held) continue;                 // released between our two calls
    const why = staleReason(held);
    if (why) {
      log(`[e2e lock] Clearing a lock left by an earlier run (${describe(held)}): ${why}.`);
      clearStale(file, held);
      continue;
    }
    const now = Date.now();
    if (held.token !== lastHolder || now - lastSaid >= remindMs) {
      log(`[e2e lock] Another full e2e run holds ${file}: ${describe(held, now)}. ` +
        `Waiting for it to finish (waited ${minutes(now - began)} so far)...`);
      lastSaid = now;
      lastHolder = held.token;
    }
    if (now - began > timeoutMs) {
      throw new Error(`[e2e lock] Gave up after ${minutes(now - began)}; still held by ${describe(held, now)}. ` +
        `If that run is really gone, delete ${file}.`);
    }
    await sleep(pollMs);
  }
  if (lastHolder) log(`[e2e lock] Got the lock after ${minutes(Date.now() - began)}.`);

  const beat = setInterval(() => {
    const cur = readLock(file);
    if (!cur || cur.token !== info.token) return;
    try { fs.writeFileSync(file, JSON.stringify({ ...info, heartbeat: Date.now() }, null, 2)); } catch { /* next beat */ }
  }, heartbeatMs);
  beat.unref();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    process.removeListener('exit', release);
    const cur = readLock(file);
    if (cur && cur.token === info.token) { try { fs.unlinkSync(file); } catch { /* gone */ } }
  };
  process.on('exit', release);           // Ctrl+C and normal exits; a hard kill is caught as stale
  return release;
}

module.exports = { acquire, isFullRun, staleReason, describe, lockPath, readLock, STALE_MS };
