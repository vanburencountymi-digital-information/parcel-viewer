// Unit tests for the e2e run lock (DIC-2436). Run: cd e2e && npm run test:lock
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { acquire, isFullRun, staleReason, readLock, STALE_MS } = require('./lock');

const tmpLock = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-lock-')), 'e2e.lock');
const pw = (...args) => ['node', 'playwright', 'test', ...args];

test('full vs targeted runs', () => {
  const env = {};
  assert.equal(isFullRun(pw(), env), true);
  assert.equal(isFullRun(pw('--reporter=line'), env), true);
  assert.equal(isFullRun(pw('--reporter', 'line', '--output', 'out'), env), true);
  assert.equal(isFullRun(pw('--project', 'desktop', '-j', '1'), env), true);
  assert.equal(isFullRun(pw('tests/smoke.spec.js'), env), false);
  assert.equal(isFullRun(pw('--reporter', 'line', 'smoke'), env), false);
  assert.equal(isFullRun(pw('-g', 'Share'), env), false);
  assert.equal(isFullRun(pw('--grep=Share'), env), false);
  assert.equal(isFullRun(pw('--last-failed'), env), false);
  assert.equal(isFullRun(pw('smoke'), { E2E_LOCK: '1' }), true);
  assert.equal(isFullRun(pw(), { E2E_LOCK: '0' }), false);
});

test('stale: holder pid gone, or heartbeat stopped', () => {
  const now = Date.now();
  const lock = { token: 't', pid: 4242, host: os.hostname(), heartbeat: now, mtime: now };
  assert.equal(staleReason(lock, now, () => true), null);
  assert.match(staleReason(lock, now, () => false), /pid 4242\) has exited/);
  const old = now - STALE_MS - 60_000;
  assert.match(staleReason({ ...lock, heartbeat: old, mtime: old }, now, () => true), /no heartbeat/);
});

test('second acquire waits, names the holder, then gets the lock', async () => {
  const file = tmpLock();
  const release1 = await acquire({ file, baseURL: 'http://x:8080', log: () => {} });
  const said = [];
  let got = false;
  const second = acquire({ file, pollMs: 20, log: (m) => said.push(m) }).then((r) => { got = true; return r; });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(got, false);
  assert.match(said[0], new RegExp(`holds .*pid ${process.pid}.*against http://x:8080`));
  release1();
  const release2 = await second;
  assert.match(said.at(-1), /Got the lock/);
  release2();
  assert.equal(fs.existsSync(file), false);
});

test('a lock left by a killed run clears itself', async () => {
  const file = tmpLock();
  // A child takes the lock, then dies without releasing it.
  const child = spawn(process.execPath, ['-e',
    `require(${JSON.stringify(path.join(__dirname, 'lock'))}).acquire({ file: ${JSON.stringify(file)}, log: () => {} })` +
    '.then(() => { console.log("held"); setInterval(() => {}, 1000); })']);
  await new Promise((r) => child.stdout.on('data', r));
  assert.equal(readLock(file).pid, child.pid);
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
  assert.ok(fs.existsSync(file), 'a hard kill leaves the lock behind');
  const said = [];
  const release = await acquire({ file, pollMs: 20, log: (m) => said.push(m) });
  assert.match(said[0], /Clearing a lock left by an earlier run.*has exited/);
  assert.equal(readLock(file).pid, process.pid);
  release();
});

test('gives up after the timeout and says who holds it', async () => {
  const file = tmpLock();
  const release = await acquire({ file, log: () => {} });
  await assert.rejects(acquire({ file, pollMs: 10, timeoutMs: 50, log: () => {} }), /Gave up .*still held by pid/);
  release();
});
