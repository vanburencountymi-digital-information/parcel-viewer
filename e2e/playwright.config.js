// Playwright config for the Parcel Viewer end-to-end suite.
//
// Runs against a live stack (default: the local docker compose at http://127.0.0.1:8080):
//   cd e2e && npm install && npx playwright test
// Point it elsewhere with E2E_BASE_URL. AI chat tests call the real model, so they only
// run with E2E_AI=1. Uses the machine's installed Edge (no browser download); set
// E2E_CHANNEL=chrome to use Chrome instead, or E2E_CHANNEL=chromium for Playwright's own
// Chromium (`npx playwright install chromium`), as CI does (.github/workflows/e2e.yml).
const { defineConfig, devices } = require('@playwright/test');

const channel = process.env.E2E_CHANNEL || 'msedge';
const ci = !!process.env.CI;

module.exports = defineConfig({
  testDir: './tests',
  globalSetup: require.resolve('./global-setup'),   // full runs take turns (DIC-2436)
  // A CI runner renders the map in software, about a third slower than a laptop: the tests
  // that load the viewer twice need the extra time there.
  timeout: ci ? 90_000 : 60_000,
  expect: { timeout: 10_000 },
  // Tests, not files, are the unit: CI's shards then split by test and come out even.
  // Each test has its own browser context, and no spec shares state between tests.
  fullyParallel: true,
  workers: 2,                    // one shared stack + DB; keep load (and rate limits) modest
  retries: 0,                    // a flaky test is a finding, not something to retry away
  forbidOnly: ci,                // a stray test.only must not shrink the CI run to one test
  reporter: [['list'], ['html', { open: 'never' }], ...(ci ? [['github']] : [])],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Edge'], channel, viewport: { width: 1400, height: 900 } }, testIgnore: /mobile\.spec\.js/ },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel, browserName: 'chromium' }, testMatch: /mobile\.spec\.js/ },
  ],
});
