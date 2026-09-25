// Real Map Buddy chat through the UI. Calls the model (costs a little), so opt-in:
//   E2E_AI=1 npx playwright test tests/ai-chat.spec.js
const { test, expect, gotoViewer } = require('./fixtures');

test.skip(!process.env.E2E_AI, 'set E2E_AI=1 to run tests that call the real model');

async function openChat(page) {
  const input = page.locator('#mb-input');
  if (!(await input.isVisible())) {
    await page.locator('#mb-tab-btn').click();   // the Map Buddy tab on the right edge
  }
  await expect(input).toBeVisible();
  return input;
}

test('chat answers, drives the map, and the input is usable again afterwards', async ({ page }) => {
  await gotoViewer(page);
  const input = await openChat(page);
  const startZoom = await page.evaluate(() => window.PS_MAP.getZoom());
  await input.fill('Zoom the map to Paw Paw.');
  await input.press('Enter');
  // A reply bubble appears and no "Thinking…" bubble is left behind.
  await expect(page.locator('.mb-msg-ai:not(.mb-msg-info)').last()).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('.mb-thinking')).toHaveCount(0, { timeout: 90_000 });
  await expect.poll(() => page.evaluate(() => window.PS_MAP.getZoom()), { timeout: 15_000 }).not.toBe(startZoom);
  await expect(input).toBeEnabled();
});

test('two turns in a row keep working (history is accepted by the server)', async ({ page }) => {
  await gotoViewer(page);
  const input = await openChat(page);
  for (const q of ['What county is this map for?', 'And what is its county seat?']) {
    await input.fill(q);
    await input.press('Enter');
    await expect(page.locator('.mb-thinking')).toHaveCount(0, { timeout: 90_000 });
  }
  const replies = page.locator('.mb-msg-ai:not(.mb-msg-info)');
  expect(await replies.count(), 'one reply per turn').toBeGreaterThanOrEqual(2);
  await expect(page.getByText(/something went wrong|Couldn’t reach the server|too long/i)).toHaveCount(0);
});
