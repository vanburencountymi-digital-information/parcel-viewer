// Theme, accessibility and AI-mode toggles: they work, persist, and survive blocked storage.
const { test, expect, gotoViewer } = require('./fixtures');

test('dark mode toggles and persists across reload', async ({ page }) => {
  await gotoViewer(page);
  const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const start = await theme();
  await page.locator('#theme-toggle').click();
  const flipped = await theme();
  expect(flipped).not.toBe(start);
  await page.reload();
  await page.waitForFunction(() => window.PS_MAP && window.PS_MAP.isStyleLoaded());
  expect(await theme()).toBe(flipped);
});

test('maximum-accessibility button toggles aria-pressed', async ({ page }) => {
  await gotoViewer(page);
  const btn = page.locator('#pv-a11y-btn');
  const before = await btn.getAttribute('aria-pressed');
  await btn.click();
  await expect(btn).not.toHaveAttribute('aria-pressed', before);
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', before);
});

test('AI mode toggle flips aria-pressed', async ({ page }) => {
  await gotoViewer(page);
  const btn = page.locator('#pv-ai-toggle');
  const before = await btn.getAttribute('aria-pressed');
  await btn.click();
  await expect(btn).not.toHaveAttribute('aria-pressed', before);
});

test('text size stays in the supported range even if a bad value was stored', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('pv-a11y-ts', '9'); } catch (_) {} });
  await gotoViewer(page);
  const ts = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pv-ts')));
  expect(ts).toBeLessThanOrEqual(1.5);
});

test('the map still loads when browser storage is blocked', async ({ page }) => {
  // Simulates "block all cookies/site data": any localStorage access throws.
  await page.addInitScript(() => {
    const deny = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
    Object.defineProperty(window, 'localStorage', { configurable: true, get: deny });
  });
  await gotoViewer(page);
  await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
});
