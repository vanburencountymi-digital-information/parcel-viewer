// Real Map Buddy chat through the UI. Calls the model (costs a little), so opt-in:
//   E2E_AI=1 npx playwright test tests/ai-chat.spec.js
const { test, expect, gotoViewer, ui } = require('./fixtures');

test.skip(!process.env.E2E_AI, 'set E2E_AI=1 to run tests that call the real model');

const chatLog = (page) => page.getByRole('log', { name: 'MapBuddy A.I. conversation' });

async function openChat(page) {
  const input = ui.mapBuddyInput(page);
  if (!(await input.isVisible())) {
    await ui.mapBuddyButton(page).click();   // the Map Buddy tab on the right edge
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
  await expect(chatLog(page).getByTestId(/^mb-msg-(ai|vision)$/).last()).toBeVisible({ timeout: 90_000 });
  await expect(chatLog(page).getByTestId('mb-thinking')).toHaveCount(0, { timeout: 90_000 });
  await expect.poll(() => page.evaluate(() => window.PS_MAP.getZoom()), { timeout: 15_000 }).not.toBe(startZoom);
  await expect(input).toBeEnabled();
});

test('two turns in a row keep working (history is accepted by the server)', async ({ page }) => {
  await gotoViewer(page);
  const input = await openChat(page);
  for (const q of ['What county is this map for?', 'And what is its county seat?']) {
    await input.fill(q);
    await input.press('Enter');
    await expect(chatLog(page).getByTestId('mb-thinking')).toHaveCount(0, { timeout: 90_000 });
  }
  const replies = chatLog(page).getByTestId(/^mb-msg-(ai|vision)$/);
  expect(await replies.count(), 'one reply per turn').toBeGreaterThanOrEqual(2);
  await expect(page.getByText(/something went wrong|Couldn’t reach the server|too long/i)).toHaveCount(0);
});
