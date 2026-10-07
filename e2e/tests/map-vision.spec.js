// Map vision (DIC-2135): Map Buddy looks at the map with an AI image model. Map Buddy's
// /chat and /vision/describe are mocked here, so this suite spends nothing; the routes
// themselves are covered by map-buddy/backend/tests/test_vision.py.
const { test, expect, gotoViewer, selectParcelViaSearch, waitForMapIdle, ui } = require('./fixtures');

const READ = 'A red barn stands east of the house, with a gravel drive from the road.';

// A Map Buddy stream that ends at once with one reply.
function sse(responseText, commands = []) {
  return 'data: ' + JSON.stringify({ type: 'done', response_text: responseText, commands, citations: [] }) + '\n\n';
}

// Mock both routes. `chatReplies` are used in order; returns the captured request bodies.
async function mockMapBuddy(page, { chatReplies = [], vision = null } = {}) {
  const calls = { chat: [], vision: [] };
  await page.route(/\/chat$/, async (route) => {
    calls.chat.push(route.request().postDataJSON());
    const r = chatReplies[calls.chat.length - 1] || ['OK.', []];
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(r[0], r[1]) });
  });
  await page.route(/\/vision\/describe$/, async (route) => {
    calls.vision.push(route.request().postDataJSON());
    const v = vision || { status: 200, body: { ok: true, description: READ, model: 'claude-opus-5-5', layers: ['Aerial imagery'], at: '2026-10-05T15:30:00+00:00' } };
    await route.fulfill({ status: v.status, contentType: 'application/json', body: JSON.stringify(v.body) });
  });
  return calls;
}

async function openChat(page) {
  const input = ui.mapBuddyInput(page);
  if (!(await input.isVisible())) await ui.mapBuddyButton(page).click();
  await expect(input).toBeVisible();
  return input;
}

const chatLog = (page) => page.getByRole('log', { name: 'MapBuddy A.I. conversation' });
const lookBtn = (page) => page.getByRole('button', { name: 'Describe this view' });
const visionRead = (page) => chatLog(page).getByTestId('mb-msg-vision');
// Any reply bubble's body (AI reply, map look read or info), as `.mb-msg-ai-body` was.
const lastBody = (page) => chatLog(page).getByTestId('mb-msg-body').last();

async function ask(page, text) {
  const input = await openChat(page);
  await input.fill(text);
  await input.press('Enter');
}

const idle = (page) => expect(chatLog(page).getByTestId('mb-thinking')).toHaveCount(0, { timeout: 20_000 });

test('"Describe this view" sends a JPEG of the map, shows a labelled read, then answers from it', async ({ page }) => {
  const calls = await mockMapBuddy(page, { chatReplies: [['There is a red barn east of the house.']] });
  await gotoViewer(page);
  const pin = await selectParcelViaSearch(page);
  await openChat(page);
  await lookBtn(page).click();
  await idle(page);

  expect(calls.vision).toHaveLength(1);
  const v = calls.vision[0];
  expect(v.media_type).toBe('image/jpeg');
  const bytes = Buffer.from(v.image, 'base64');
  expect(bytes.subarray(0, 3).toString('hex'), 'a JPEG').toBe('ffd8ff');
  expect(bytes.length).toBeLessThanOrEqual(2_000_000);
  expect(v.question).toBeNull();
  expect(v.parcel.pin).toBe(pin);
  expect(Array.isArray(v.layers)).toBe(true);
  const size = await page.evaluate(() => {
    const c = window.PS_MAP.getCanvas();
    return window.PV_VISION.fitSize(c.width, c.height, 2576);
  });
  expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2576);

  const read = visionRead(page);
  await expect(read.getByTestId('mb-msg-label')).toHaveText('AI visual read of the current map view');
  await expect(read.getByTestId('mb-msg-body')).toHaveText(READ);
  await expect(read.getByTestId('mb-vision-meta')).toContainText('Layers: Aerial imagery');
  await expect(read.getByTestId('mb-vision-meta')).toContainText('not a survey or tax record');

  expect(calls.chat).toHaveLength(1);
  expect(calls.chat[0].message).toBe('What do you see in the current map view?');
  expect(calls.chat[0].vision_read).toEqual({ description: READ, layers: ['Aerial imagery'] });
  await expect(chatLog(page).getByTestId('mb-msg-user')).toHaveText(['Describe this view']);
  await expect(chatLog(page).getByTestId('mb-msg-ai').getByTestId('mb-msg-body').last())
    .toHaveText('There is a red barn east of the house.');
  await expect(lookBtn(page)).toBeEnabled();
});

test('when the AI asks to look, the look runs and the answer follows without asking again', async ({ page }) => {
  const calls = await mockMapBuddy(page, {
    chatReplies: [
      ['Taking a look at the aerial.', [{ type: 'look_at_map', payload: { question: 'Is there a barn?' } }]],
      ['Yes: the visual read shows a red barn east of the house.'],
    ],
  });
  await gotoViewer(page);
  await ask(page, 'Look at the aerial: is there a barn?');
  await idle(page);
  await expect(lastBody(page)).toHaveText('Yes: the visual read shows a red barn east of the house.');

  expect(calls.vision).toHaveLength(1);
  expect(calls.vision[0].question).toBe('Is there a barn?');
  expect(calls.chat).toHaveLength(2);
  expect(calls.chat[0].vision_read).toBeUndefined();
  expect(calls.chat[1].message).toBe('Is there a barn?');
  expect(calls.chat[1].vision_read.description).toBe(READ);
  await expect(chatLog(page).getByTestId('mb-msg-user'), 'the user asked once').toHaveCount(1);
});

test('an offer is one button, costs nothing until tapped, and is never made twice', async ({ page }) => {
  const offer = [{ type: 'offer_map_look', payload: { question: 'Is there a barn?' } }];
  const calls = await mockMapBuddy(page, {
    chatReplies: [
      ['The tax roll doesn’t list outbuildings. Want me to look at the aerial?', offer],
      ['The parcel is 12.5 acres.', offer],
      ['There is a red barn east of the house.'],
    ],
  });
  await gotoViewer(page);
  await ask(page, 'Is there a barn on this parcel?');
  await idle(page);
  const chip = chatLog(page).getByRole('button', { name: 'Look at the map' });
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText('Look at the map');
  expect(calls.vision, 'no look until the user taps').toHaveLength(0);
  expect(calls.chat[0].vision_offered).toBe(false);

  await ask(page, 'How big is it?');
  await idle(page);
  expect(calls.chat[1].vision_offered, 'the server is told an offer was made').toBe(true);
  await expect(chip, 'a second offer is not shown').toHaveCount(1);

  await chip.click();
  await idle(page);
  await expect(chip).toHaveCount(0);
  expect(calls.vision).toHaveLength(1);
  expect(calls.vision[0].question).toBe('Is there a barn?');
  expect(calls.chat[2].vision_read.description).toBe(READ);
  await expect(lastBody(page)).toHaveText('There is a red barn east of the house.');
});

test('"Describe this spot" on the right-click menu centers there and looks', async ({ page }) => {
  const calls = await mockMapBuddy(page, { chatReplies: [['Woodland with a small pond.']] });
  await gotoViewer(page);
  const box = await ui.mapCanvas(page).boundingBox();
  const pt = { x: Math.round(box.x + box.width * 0.35), y: Math.round(box.y + box.height * 0.45) };
  const target = await page.evaluate(({ x, y }) => {
    const r = window.PS_MAP.getCanvas().getBoundingClientRect();
    const ll = window.PS_MAP.unproject([x - r.left, y - r.top]);
    return [ll.lng, ll.lat];
  }, pt);
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: /^Describe this spot/ }).click();
  await idle(page);
  await waitForMapIdle(page);

  const center = await page.evaluate(() => { const c = window.PS_MAP.getCenter(); return [c.lng, c.lat]; });
  expect(Math.abs(center[0] - target[0])).toBeLessThan(1e-5);
  expect(Math.abs(center[1] - target[1])).toBeLessThan(1e-5);
  expect(calls.vision).toHaveLength(1);
  expect(calls.vision[0].question).toMatch(/center of the map view/);
  await expect(ui.mapBuddyInput(page)).toBeVisible();
  await expect(chatLog(page).getByTestId('mb-msg-user')).toHaveText(['Describe this spot']);
  await expect(lastBody(page)).toHaveText('Woodland with a small pond.');
});

test('a tilted, rotated map is turned straight down and north up before the look', async ({ page }) => {
  const calls = await mockMapBuddy(page, { chatReplies: [['OK.']] });
  await gotoViewer(page);
  await page.evaluate(() => window.PS_MAP.jumpTo({ pitch: 55, bearing: 140 }));
  await openChat(page);
  await lookBtn(page).click();
  await idle(page);
  const cam = await page.evaluate(() => ({ pitch: window.PS_MAP.getPitch(), bearing: window.PS_MAP.getBearing() }));
  expect(cam).toEqual({ pitch: 0, bearing: 0 });
  expect(calls.vision).toHaveLength(1);
  expect(calls.vision[0].view_width_ft, 'the model gets a scale').toBeGreaterThan(0);
});

test('a bolded best guess in the read shows as bold, not as asterisks', async ({ page }) => {
  // Seen in the DIC-2138 evaluation: "planted in a **perennial row crop**, most likely **blueberries**".
  const calls = await mockMapBuddy(page, {
    chatReplies: [['OK.']],
    vision: { status: 200, body: { ok: true, description: 'Most likely **blueberries** <img src=x onerror=alert(1)>.', model: 'm', layers: [], at: '2026-10-05T15:30:00+00:00' } },
  });
  await gotoViewer(page);
  await openChat(page);
  await lookBtn(page).click();
  await idle(page);
  const body = visionRead(page).getByTestId('mb-msg-body');
  await expect(body.locator('strong')).toHaveText('blueberries');
  await expect(body).not.toContainText('**');
  await expect(body.locator('img'), 'model text is escaped, never HTML').toHaveCount(0);
  expect(calls.vision).toHaveLength(1);
});

test('a failed look says so plainly and makes no chat call', async ({ page }) => {
  const calls = await mockMapBuddy(page, { vision: { status: 200, body: { ok: false, error: 'Couldn’t analyse the map view.' } } });
  await gotoViewer(page);
  await openChat(page);
  await lookBtn(page).click();
  await idle(page);
  await expect(lastBody(page)).toHaveText('Couldn’t analyse the map view. Please try again in a moment.');
  expect(calls.chat).toHaveLength(0);
  await expect(visionRead(page)).toHaveCount(0);
  await expect(lookBtn(page)).toBeEnabled();
});

test('the per-person look limit gets its own message', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/status of 429/);
  const calls = await mockMapBuddy(page, { vision: { status: 429, body: { error: 'Rate limit exceeded' } } });
  await gotoViewer(page);
  await openChat(page);
  await lookBtn(page).click();
  await idle(page);
  await expect(lastBody(page)).toContainText('limit for map looks');
  expect(calls.chat).toHaveLength(0);
});

// DIC-2144: the federal overlay servers are slow (a new zoom-16 view took 3–9 s) and can
// fail; USFWS also answers headless browsers with a 500. The wetlands tiles are stubbed
// here so the outcome doesn't depend on that server.
const NWI = /fwspublicservices\.wim\.usgs\.gov\/wetlandsmapservice/;
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function turnOnWetlandsAndLook(page) {
  await page.evaluate(() => { window.PS_MAP.jumpTo({ zoom: 15 }); });
  await waitForMapIdle(page);
  await openChat(page);
  await page.evaluate(() => window.PS_OVERLAY_LAYERS.setOverlay('overlay-wetlands', true));
  await lookBtn(page).click();   // straight away, before any tile is back
  await idle(page);
}

test('a look right after wetlands turn on waits for their slow tiles', async ({ page }) => {
  const tilesDone = [];
  await page.route(NWI, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: PNG_1PX });
    tilesDone.push(Date.now());
  });
  const calls = await mockMapBuddy(page, { chatReplies: [['Wetlands cover the south half.']] });
  let visionAt = 0;
  page.on('request', (r) => { if (/\/vision\/describe$/.test(r.url())) visionAt = Date.now(); });
  await gotoViewer(page);
  await selectParcelViaSearch(page);

  await turnOnWetlandsAndLook(page);

  expect(tilesDone.length, 'wetlands tiles were requested').toBeGreaterThan(0);
  expect(visionAt, 'the screenshot waited for the wetlands tiles').toBeGreaterThanOrEqual(Math.max(...tilesDone));
  expect(calls.vision[0].layers_incomplete).toBeNull();
});

test('a look with a failing wetlands service says the layer did not fully load', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/status of 500.*wetlandsmapservice/);
  await page.route(NWI, (route) => route.fulfill({ status: 500, contentType: 'text/html', body: 'error' }));
  const calls = await mockMapBuddy(page, {
    chatReplies: [['The wetlands layer did not load.']],
    vision: { status: 200, body: { ok: true, description: READ, model: 'claude-sonnet-5-5', layers: ['Aerial imagery', 'Wetlands (USFWS NWI)'], layers_incomplete: ['Wetlands (USFWS NWI)'], at: '2026-10-06T12:00:00+00:00' } },
  });
  await gotoViewer(page);
  await selectParcelViaSearch(page);

  await turnOnWetlandsAndLook(page);

  expect(calls.vision[0].layers_incomplete).toEqual(['Wetlands (USFWS NWI)']);
  await expect(visionRead(page).getByTestId('mb-vision-meta')).toContainText('not fully loaded: Wetlands (USFWS NWI)');
});
