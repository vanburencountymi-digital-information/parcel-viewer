// Map Buddy's chat panel (DIC-2389: written against the classic map-buddy.js before the
// panel moved to Vue). /chat is always stubbed with a scripted event stream, so nothing
// here calls the model: the panel, the composer, how a reply renders (Markdown, the map
// actions it took, sources, suggestions), the conversation it sends back, and every way
// a turn can fail. The live model is ai-chat.spec.js (E2E_AI=1); looks are map-vision.spec.js.
const { test, expect, gotoViewer, selectParcelViaSearch, ui } = require('./fixtures');

const chatLog = (page) => page.getByRole('log', { name: 'MapBuddy A.I. conversation' });
const input = (page) => ui.mapBuddyInput(page);
const sendBtn = (page) => page.getByRole('button', { name: 'Send', exact: true });
const thinking = (page) => chatLog(page).getByTestId('mb-thinking');
const lastReply = (page) => chatLog(page).getByTestId('mb-msg-ai').last();
const idle = (page) => expect(thinking(page)).toHaveCount(0, { timeout: 20_000 });

const sseEvent = (e) => 'data: ' + JSON.stringify(e) + '\n\n';
const done = (response_text, extra = {}) => sseEvent({ type: 'done', response_text, commands: [], citations: [], ...extra });

// Stub /chat: each reply is a body string, or { status, body }, or a function of the
// request that resolves to one. Returns the request bodies sent.
async function stubChat(page, replies = []) {
  const sent = [];
  await page.route(/\/chat$/, async (route) => {
    sent.push(route.request().postDataJSON());
    let r = replies[sent.length - 1];
    if (typeof r === 'function') r = await r();
    if (r == null) r = done('OK.');
    if (typeof r === 'string') r = { status: 200, body: r };
    await route.fulfill({ status: r.status, contentType: r.status === 200 ? 'text/event-stream' : 'application/json', body: r.body });
  });
  return sent;
}

async function openChat(page) {
  if (!(await input(page).isVisible())) await ui.mapBuddyButton(page).click();
  await expect(input(page)).toBeVisible();
}
async function ask(page, text) {
  await openChat(page);
  await input(page).fill(text);
  await input(page).press('Enter');
}

test.beforeEach(async ({ page }) => {
  // Nothing in this file may reach the model: a look or an unstubbed turn fails loudly.
  await page.route(/\/vision\/describe$/, (route) => route.fulfill({ status: 500, json: { error: 'not in this spec' } }));
  await page.route(/\/workflows$/, (route) => route.fulfill({ json: { workflows: [] } }));
});

test.describe('the panel', () => {
  test('opens from its tab, collapses, and remembers which across a reload', async ({ page }) => {
    await stubChat(page);
    await gotoViewer(page);
    await expect(input(page)).toBeHidden();
    await ui.mapBuddyButton(page).click();
    await expect(input(page)).toBeVisible();
    expect(await page.evaluate(() => window.PV_MAP_BUDDY.isOpen())).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('mb:collapsed'))).toBe('false');

    await page.reload();
    await expect(input(page)).toBeVisible();

    await page.getByRole('button', { name: 'Collapse MapBuddy A.I.' }).click();
    await expect(input(page)).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('mb:collapsed'))).toBe('true');
    expect(await page.evaluate(() => window.PV_MAP_BUDDY.isOpen())).toBe(false);
  });

  test('drag-resizes between its limits and remembers the width', async ({ page }) => {
    await stubChat(page);
    await gotoViewer(page);
    await openChat(page);
    const panel = page.locator('#map-buddy-panel');
    const handle = page.getByRole('separator', { name: 'Drag to resize MapBuddy A.I. panel' });
    const box = await handle.boundingBox();
    const startW = (await panel.boundingBox()).width;
    await page.mouse.move(box.x + 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x - 98, box.y + 200, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await panel.boundingBox()).width)).toBe(Math.round(startW + 100));
    expect(await page.evaluate(() => localStorage.getItem('mb:width'))).toBe(String(Math.round(startW + 100)));

    await page.mouse.move(box.x - 100, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x - 900, box.y + 200, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await panel.boundingBox()).width)).toBe(620);   // the widest it goes

    await page.reload();
    await expect(input(page)).toBeVisible();
    expect(Math.round((await panel.boundingBox()).width)).toBe(620);
  });

  test('the welcome ideas follow the selected parcel, and tapping one asks it', async ({ page }) => {
    const sent = await stubChat(page);
    await gotoViewer(page);
    await openChat(page);
    const ideas = chatLog(page).locator('.mb-quick-btn');
    await expect(ideas).toHaveText(['Find a parcel by owner name or address', 'Tilt the map to 3-D with terrain shading', 'What can you do?']);
    await expect(page.locator('#mb-context-text')).toHaveText('No parcel selected');
    await expect(input(page)).toHaveAttribute('placeholder', 'Ask about this parcel or search by owner…');

    const pin = await selectParcelViaSearch(page);
    await expect(ideas).toHaveCount(4);
    await expect(ideas.nth(1)).toHaveText(`Is ${pin} at risk of flooding or wetlands?`);
    await expect(chatLog(page).locator('.mb-empty-state')).toContainText(`Parcel ${pin} is selected`);
    await expect(page.locator('#mb-context-text')).toHaveText(new RegExp('^' + pin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' · [\\d.]+ ac'));
    await expect(input(page)).toHaveAttribute('placeholder', `Ask about parcel ${pin}…`);

    await ideas.first().click();
    await idle(page);
    expect(sent[0].message).toBe('Give me the rundown on this parcel');
    expect(sent[0].parcel_context.pin).toBe(pin);
    await expect(chatLog(page).locator('.mb-empty-state')).toHaveCount(0);
  });
});

test.describe('a turn', () => {
  test('Enter sends; Shift+Enter is a new line; nothing is sent empty; the composer locks until the reply', async ({ page }) => {
    let release;
    const held = new Promise((r) => { release = r; });
    const sent = await stubChat(page, [async () => { await held; return sseEvent({ type: 'status', message: 'Checking the tax roll…' }) + done('Done.'); }]);
    await gotoViewer(page);
    await openChat(page);
    await input(page).press('Enter');
    await input(page).fill('   ');
    await input(page).press('Enter');
    await input(page).fill('line one');
    await input(page).press('Shift+Enter');
    await input(page).pressSequentially('line two');
    await expect(input(page)).toHaveValue('line one\nline two');
    expect(sent).toHaveLength(0);

    await input(page).press('Enter');
    await expect(chatLog(page).getByTestId('mb-msg-user')).toHaveText('line one\nline two');
    await expect(input(page)).toHaveValue('');
    await expect(sendBtn(page)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Describe this view' })).toBeDisabled();
    await expect(thinking(page)).toContainText('Thinking…');
    release();
    await idle(page);
    await expect(lastReply(page).getByTestId('mb-msg-label')).toHaveText('MapBuddy A.I.');
    await expect(lastReply(page).getByTestId('mb-msg-body')).toHaveText('Done.');
    await expect(sendBtn(page)).toBeEnabled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ message: 'line one\nline two', conversation_history: [], parcel_context: null, vision_offered: false });
    expect(sent[0].map_state.center).toHaveLength(2);
  });

  test('a reply renders its Markdown safely', async ({ page }) => {
    await stubChat(page, [done('## Flood risk\nThe parcel is **mostly** dry, see `zone X`.\nIt is *not* in a floodway.\n\n- one\n- two\n\n1. first\n2. second\n\n**Wetlands:**\n<script>window.__mbXss = 1</script><b>raw</b>')]);
    await gotoViewer(page);
    await ask(page, 'Flood?');
    await idle(page);
    const body = lastReply(page).getByTestId('mb-msg-body');
    await expect(body.locator('.mb-h')).toHaveText(['Flood risk', 'Wetlands:']);   // a colon inside the bold stays
    await expect(body.locator('p').first()).toHaveText('The parcel is mostly dry, see zone X.It is not in a floodway.');
    await expect(body.locator('strong').first()).toHaveText('mostly');
    await expect(body.locator('code')).toHaveText('zone X');
    await expect(body.locator('em')).toHaveText('not');
    await expect(body.locator('ul li')).toHaveText(['one', 'two']);
    await expect(body.locator('ol li')).toHaveText(['first', 'second']);
    await expect(body).toContainText('<script>window.__mbXss = 1</script><b>raw</b>');
    expect(await page.evaluate(() => window.__mbXss)).toBeUndefined();
    await expect(body.locator('b')).toHaveCount(0);
  });

  test('the map actions a reply took show as chips; its sources as citation buttons', async ({ page }) => {
    await stubChat(page, [done('Zoomed in.', {
      commands: [{ type: 'zoom_to', payload: { zoom: 12.4 } }, { type: 'set_pitch', payload: { pitch: 45 } }, { type: 'no_such_command' }],
      citations: [{ source_id: 'MCL 211.27a', anchor: 's1', span: 'taxable value' }],
    })]);
    await gotoViewer(page);
    await ask(page, 'Zoom in');
    await idle(page);
    await expect(lastReply(page).locator('.mb-action-chip')).toHaveText(['Zoom 12', 'Tilt 45°']);
    const src = lastReply(page).getByTestId('cite-trigger');
    await expect(src).toHaveText('MCL 211.27a');
    await expect(src).toHaveAttribute('data-cite-source', 'MCL 211.27a');
    await expect(src).toHaveAttribute('data-cite-anchor', 's1');
    await expect(src).toHaveAttribute('data-cite-span', 'taxable value');
    await expect(lastReply(page).locator('.mb-sources-label')).toHaveText('Sources');
    await expect.poll(() => page.evaluate(() => Math.round(window.PS_MAP.getZoom()))).toBe(12);
  });

  test('suggested next steps are up to four chips; tapping one asks it', async ({ page }) => {
    const sent = await stubChat(page, [done('Anything else?', { commands: [{ type: 'suggest_actions', payload: { suggestions: [
      '🔍 Search by owner', { label: '📐 Measure it', prompt: 'Measure this parcel with dimensions' }, '', 'Three', 'Four', 'Five',
    ] } }] }), done('Measured.')]);
    await gotoViewer(page);
    await ask(page, 'Help');
    await idle(page);
    const chips = chatLog(page).locator('.mb-suggest-chip');
    await expect(chips).toHaveText(['Search by owner', 'Measure it', 'Three', 'Four']);
    await chips.nth(1).click();
    await idle(page);
    expect(sent[1].message).toBe('Measure this parcel with dimensions');
    await expect(chatLog(page).getByTestId('mb-msg-user').last()).toHaveText('Measure this parcel with dimensions');
  });

  test('results the model cannot see come back as their own bubbles; a result list selects a parcel', async ({ page }) => {
    const pin = await (async () => { await gotoViewer(page); return selectParcelViaSearch(page); })();
    const prefix = pin.slice(0, 3);
    await stubChat(page, [done('Measured and searched.', { commands: [
      { type: 'measure_distance', payload: { coordinates: [[-85.905, 42.211], [-85.895, 42.211]] } },
      { type: 'search_parcels', payload: { query: 'zz<b>nomatch' } },
      { type: 'search_parcels', payload: { query: prefix } },
    ] })]);
    await ask(page, 'Measure and search');
    await idle(page);
    const info = chatLog(page).getByTestId('mb-msg-info');
    await expect(info.nth(0)).toContainText(/^Distance[\d,.]+ ft \(0\.\d\d mi\)$/);
    await expect(info.nth(1)).toHaveText('No parcels matched “zz<b>nomatch”.');
    const results = info.nth(2).locator('.mb-result-btn');
    await expect(info.nth(2)).toContainText(new RegExp('^\\d+ matches for “' + prefix + '”'));
    const other = results.nth(1);
    const otherPin = (await other.getAttribute('data-pin'));
    await other.click();
    await expect(page.getByTestId('parcel-info-pin')).toHaveText(otherPin);
    await expect(lastReply(page).locator('.mb-action-chip')).toHaveText([/^Measured distance$/, 'No matches', /^\d+ matches$/]);
  });

  test('the conversation goes back with each turn, but only turns with a reply', async ({ page }) => {
    const sent = await stubChat(page, [done('First answer.'), done('   '), done('Third answer.')]);
    await gotoViewer(page);
    for (const q of ['One?', 'Two?', 'Three?']) { await ask(page, q); await idle(page); }
    expect(sent[1].conversation_history).toEqual([{ role: 'user', content: 'One?' }, { role: 'assistant', content: 'First answer.' }]);
    expect(sent[2].conversation_history).toHaveLength(2);   // the empty reply wasn't kept
  });
});

test.describe('a turn that fails', () => {
  test('an error event, a stream that stops early, and each HTTP refusal say what happened', async ({ page, consoleGuard }) => {
    consoleGuard.allow(/status of (404|413|422|429|500)|\[Map Buddy\]/);
    await stubChat(page, [
      sseEvent({ type: 'error', message: 'the tax roll is down' }),
      sseEvent({ type: 'status', message: 'Working…' }),
      { status: 404, body: '{}' },
      { status: 429, body: '{}' },
      { status: 413, body: '{}' },
      { status: 422, body: '{}' },
      { status: 500, body: '{}' },
    ]);
    await gotoViewer(page);
    const expected = [
      'Sorry, something went wrong: the tax roll is down',
      'Map Buddy stopped before finishing. Please try again.',
      'The AI backend isn’t connected yet. Check back soon!',
      'Map Buddy is busy right now. Please wait a moment and try again.',
      'That request was too long for Map Buddy. Try a shorter message.',
      'That request was too long for Map Buddy. Try a shorter message.',
      'Couldn’t reach the server. Please try again.',
    ];
    for (const [i, text] of expected.entries()) {
      await ask(page, 'Question ' + i);
      await idle(page);
      await expect(lastReply(page).getByTestId('mb-msg-body')).toHaveText(text);
      await expect(sendBtn(page)).toBeEnabled();
    }
  });

  test('the panel API asks, opens and toggles as hints.js and the mobile tab use it', async ({ page }) => {
    const sent = await stubChat(page);
    await gotoViewer(page);
    await page.evaluate(() => window.PV_MAP_BUDDY.ask('From a hint'));
    await expect(input(page)).toBeVisible();
    await idle(page);
    expect(sent[0].message).toBe('From a hint');
    await page.evaluate(() => window.PV_MAP_BUDDY.send('From send()'));
    await idle(page);
    expect(sent[1].message).toBe('From send()');
    await page.evaluate(() => window.PV_MAP_BUDDY.collapse());
    await expect(input(page)).toBeHidden();
    await page.evaluate(() => window.PV_MAP_BUDDY.open());
    await expect(input(page)).toBeVisible();
  });
});
