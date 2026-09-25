// Playwright config for the Parcel Viewer end-to-end suite.
//
// Runs against a live stack (default: the local docker compose at http://127.0.0.1:8080):
//   cd e2e && npm install && npx playwright test
// Point it elsewhere with E2E_BASE_URL. AI chat tests call the real model, so they only
// run with E2E_AI=1. Uses the machine's installed Edge (no browser download); set
// E2E_CHANNEL=chrome to use Chrome instead.
const { defineConfig, devices } = require('@playwright/test');

const channel = process.env.E2E_CHANNEL || 'msedge';

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,          // one shared stack + DB; keep load (and rate limits) modest
  workers: 2,
  retries: 0,                    // a flaky test is a finding, not something to retry away
  reporter: [['list'], ['html', { open: 'never' }]],
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
