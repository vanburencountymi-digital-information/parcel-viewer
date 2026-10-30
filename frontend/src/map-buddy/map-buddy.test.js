// Map Buddy's panel as a Vue island (DIC-2389; was map-buddy.js): the Markdown renderer,
// the store (turns streamed from a faked /chat, looks, automations, the panel's state),
// and the component. No model is called anywhere: the e2e suite stubs /chat too
// (map-buddy-chat.spec.js, map-vision.spec.js, automations.spec.js).
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { deIcon, renderMarkdown } from './markdown.js';
import MapBuddyPanel from './MapBuddyPanel.vue';
import { chatFailureText, contextText, createMapBuddyStore, starterIdeas, suggestionItems } from './store.js';

// ── Fakes ─────────────────────────────────────────────────────────────────────
const sse = (...events) => events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('');
const done = (response_text, extra = {}) => ({ type: 'done', response_text, commands: [], citations: [], ...extra });

/** A streamed Response whose body arrives in the given chunks. */
function streamed(...chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }) }) } };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function setup({ chat = [], routes = {}, storage = memoryStorage(), vision = null, mobile = false, citations = true } = {}) {
  const sent = { chat: [], vision: [], workflow: [] };
  const fetch = vi.fn(async (url, opts = {}) => {
    const path = url.replace('/mb', '');
    if (path === '/chat') {
      sent.chat.push(JSON.parse(opts.body));
      const r = chat.shift();
      if (r instanceof Error) throw r;
      return typeof r === 'string' ? streamed(r) : (r || streamed(sse(done('OK.'))));
    }
    if (path === '/vision/describe') { sent.vision.push(JSON.parse(opts.body)); return routes.vision || json(200, { ok: true, description: 'A **red** barn.', layers: ['Aerial'], at: '2026-10-05T15:30:00Z' }); }
    if (path === '/workflow') { sent.workflow.push(JSON.parse(opts.body)); return routes.workflow || json(200, { commands: [] }); }
    if (path === '/workflows') return routes.workflows || json(200, { workflows: [] });
    return json(404, {});
  });
  const ui = {};
  const cmd = {
    run: vi.fn((cmds) => cmds.map((c) => '🔍 ' + c.type)),
    buildMapState: vi.fn(() => ({ center: [-86, 42], zoom: 12, layers: [{ id: 'wet', label: 'Wetlands', visible: true }, { id: 'x', visible: false }] })),
    cancelCinematic: vi.fn(),
    selectResult: vi.fn(),
  };
  const log = { error: vi.fn() };
  const store = createMapBuddyStore({
    fetch, apiBase: () => '/mb', storage: () => storage,
    commands: (adapter) => { Object.assign(ui, adapter); return cmd; },
    vision: () => vision, map: () => 'the-map', citationsEnabled: () => citations,
    isMobile: () => mobile, log, timers: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  return { store, state: store.state, sent, fetch, ui, cmd, log, storage };
}
const kinds = (state) => state.messages.map((m) => m.kind);
const last = (state) => state.messages[state.messages.length - 1];

// ── Markdown ──────────────────────────────────────────────────────────────────
describe('renderMarkdown', () => {
  it('headings, lists, paragraphs and inline marks, with everything escaped', () => {
    expect(renderMarkdown('## Title\nOne **bold** `code` *em* _em2_\ntwo\n\n- a\n- b\n1. c\n**Label:**\n<script>x</script>')).toBe(
      '<div class="mb-h">Title</div><p>One <strong>bold</strong> <code>code</code> <em>em</em> <em>em2</em><br>two</p>' +
      '<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol><div class="mb-h"><strong>Label:</strong></div><p>&lt;script&gt;x&lt;/script&gt;</p>');
    expect(renderMarkdown('  \n ')).toBe('');
    expect(deIcon('🔍 Zoom 12')).toBe('Zoom 12');
  });
});

// ── The store ─────────────────────────────────────────────────────────────────
describe('Map Buddy store: a turn', () => {
  it('sends the message with the parcel, the map and the history; renders the reply; keeps the turn', async () => {
    const { store, state, sent } = setup({ chat: [sse(done('Hi **there**')), sse(done('Again.'))] });
    store.setParcel({ pin: '80-01', acres: 12.34, owner_name: 'A B C', geometry: {}, centroid: [1, 2] });
    await store.send('  Hello  ');
    expect(state.welcome).toBe(false);
    expect(kinds(state)).toEqual(['user', 'ai']);
    expect(state.messages[0].text).toBe('Hello');
    expect(last(state).html).toBe('<p>Hi <strong>there</strong></p>');
    expect(sent.chat[0]).toMatchObject({ message: 'Hello', conversation_history: [], vision_offered: false, parcel_context: { pin: '80-01', acres: 12.34, centroid: [1, 2] } });
    expect(sent.chat[0].parcel_context).not.toHaveProperty('geometry');
    await store.send('Next');
    expect(sent.chat[1].conversation_history).toEqual([{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi **there**' }]);
    expect(state.streaming).toBe(false);
  });

  it('nothing is sent empty or while a turn runs; the draft stays', async () => {
    let release;
    const { store, state, sent } = setup({ chat: [new Promise((r) => { release = r; })] });
    await store.send('   ');
    expect(sent.chat).toHaveLength(0);
    const p = store.send('First');
    expect(state.streaming).toBe(true);
    expect(last(state).kind).toBe('thinking');
    await store.send('Second');
    expect(state.draft).toBe('Second');
    expect(sent.chat).toHaveLength(1);
    release(streamed(sse(done('Done.'))));
    await p;
    expect(state.streaming).toBe(false);
  });

  it('a status event updates Thinking; events split across chunks still parse; chips and sources show', async () => {
    let read;
    const { store, state, cmd } = setup({ chat: [new Promise((r) => { read = r; })] });
    const p = store.send('Q');
    const enc = new TextEncoder();
    const chunks = [sse({ type: 'status', message: 'Checking the roll…' }), 'data: {"type":"do', 'ne","response_text":"A.","commands":[{"type":"zoom_to"}],"citations":[{"source_id":"MCL 1"}]}\n\n'];
    let n = 0;
    let wait;
    read({ ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise((r) => { wait = () => r(n < chunks.length ? { done: false, value: enc.encode(chunks[n++]) } : { done: true }); }) }) } });
    await flushPromises();
    wait();
    await flushPromises();
    expect(last(state)).toMatchObject({ kind: 'thinking', text: 'Checking the roll…' });
    wait(); await flushPromises(); wait(); await flushPromises(); wait();
    await p;
    expect(kinds(state)).toEqual(['user', 'ai']);
    expect(last(state)).toMatchObject({ chips: ['zoom_to'], citations: [{ source_id: 'MCL 1' }] });
    expect(cmd.run).toHaveBeenCalledWith([{ type: 'zoom_to' }]);
  });

  it('sources are left out when citations are gated off; an empty reply is not kept in the history', async () => {
    const { store, state, sent } = setup({ citations: false, chat: [sse(done('  ', { citations: [{ source_id: 'x' }] })), sse(done('B'))] });
    await store.send('A');
    expect(last(state).citations).toEqual([]);
    await store.send('B');
    expect(sent.chat[1].conversation_history).toEqual([]);
  });

  it('each failure says what happened, and the composer unlocks', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { store, state, log } = setup({ chat: [
      sse({ type: 'error', message: 'boom' }), sse({ type: 'status', message: 'x' }), json(429, {}), abort, new TypeError('offline'),
    ] });
    const texts = [];
    for (let i = 0; i < 5; i++) { await store.send('Q' + i); texts.push(last(state).html); }
    expect(texts).toEqual([
      '<p>Sorry, something went wrong: boom</p>',
      '<p>Map Buddy stopped before finishing. Please try again.</p>',
      '<p>Map Buddy is busy right now. Please wait a moment and try again.</p>',
      '<p>That took too long, so I stopped waiting. Please try again.</p>',
      '<p>Couldn’t reach the server. Please try again.</p>',
    ]);
    expect(kinds(state).includes('thinking')).toBe(false);
    expect(state.streaming).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(3);
    expect(chatFailureText({ status: 404 })).toBe('The AI backend isn’t connected yet. Check back soon!');
    expect(chatFailureText({ status: 422 })).toBe('That request was too long for Map Buddy. Try a shorter message.');
  });

  it('the commands’ adapter: info and result bubbles, suggestions, the parcel', () => {
    const { store, state, ui } = setup();
    store.setParcel({ pin: '80-01' });
    expect(ui.currentParcel()).toEqual({ pin: '80-01' });
    ui.info('<strong>Area</strong>');
    ui.results('<button class="mb-result-btn" data-pin="80-02">x</button>');
    ui.suggest(['🔍 Find', { label: 'Measure', prompt: 'Measure it' }, '', 'c', 'd', 'e']);
    ui.suggest([]);
    expect(kinds(state)).toEqual(['info', 'info', 'suggest']);
    expect(last(state).items).toEqual([{ label: 'Find', prompt: '🔍 Find' }, { label: 'Measure', prompt: 'Measure it' }, { label: 'c', prompt: 'c' }, { label: 'd', prompt: 'd' }]);
    expect(state.welcome).toBe(true);   // bubbles from a command don't end the welcome
  });
});

describe('Map Buddy store: looks', () => {
  const vision = () => ({ capture: vi.fn(async () => ({ data: 'jpg', media_type: 'image/jpeg', view_width_ft: 900, incomplete: ['Wetlands'] })) });

  it('a look captures the map, shows the labelled read, then answers from it', async () => {
    const v = vision();
    const { store, state, sent, cmd } = setup({ vision: v, chat: [sse(done('A barn.'))] });
    store.setParcel({ pin: '80-01', acres: 2 });
    await store.startLook({ question: null, userLabel: 'Describe this view' });
    expect(v.capture).toHaveBeenCalledWith('the-map');
    expect(cmd.cancelCinematic).toHaveBeenCalled();
    expect(sent.vision[0]).toMatchObject({ image: 'jpg', view_width_ft: 900, question: null, layers: ['Wetlands'], layers_incomplete: ['Wetlands'], parcel: { pin: '80-01', acres: 2 } });
    expect(kinds(state)).toEqual(['user', 'vision', 'ai']);
    expect(state.messages[1].html).toBe('<p>A <strong>red</strong> barn.</p>');
    expect(state.messages[1].meta).toMatch(/^Layers: Aerial · .+ · An interpretation of the imagery, not a survey or tax record$/);
    expect(sent.chat[0]).toMatchObject({ message: 'What do you see in the current map view?', vision_read: { description: 'A **red** barn.', layers: ['Aerial'] } });
  });

  it('the AI asking to look runs a look after its reply; an offer is made once, and only a tap spends', async () => {
    const v = vision();
    const { store, state, ui, sent } = setup({ vision: v, chat: [
      sse(done('Let me look.')), sse(done('I see it.')), sse(done('Want a look?')), sse(done('Another?')), sse(done('Barn.')),
    ] });
    const p = store.send('Is there a barn?');
    ui.requestLook('Is there a barn?');
    await p;
    expect(sent.vision).toHaveLength(1);
    expect(sent.chat[1].message).toBe('Is there a barn?');

    ui.offerLook('Look?');
    ui.offerLook('Again?');
    expect(kinds(state).filter((k) => k === 'lookOffer')).toHaveLength(1);
    await store.send('More');
    expect(sent.chat[2].vision_offered).toBe(true);
    expect(sent.vision).toHaveLength(1);
    await store.acceptLookOffer(state.messages.find((m) => m.kind === 'lookOffer'));
    expect(kinds(state).includes('lookOffer')).toBe(false);
    expect(sent.vision).toHaveLength(2);
    expect(sent.vision[1].question).toBe('Look?');
  });

  it('a failed look says why and asks nothing more; without vision it says so', async () => {
    for (const [route, text] of [
      [json(429, {}), 'You’ve reached the limit for map looks for now. Please try again later.'],
      [json(200, { ok: false, degraded: true }), 'Map looks are paused for now because the AI limit was reached.'],
      [json(400, { error: 'too dark' }), 'Couldn’t analyse the map view: too dark'],
    ]) {
      const { store, state, sent } = setup({ vision: vision(), routes: { vision: route } });
      await store.startLook({ question: 'q' });
      expect(last(state).html).toBe('<p>' + text + '</p>');
      expect(sent.chat).toHaveLength(0);
    }
    const none = setup();
    await none.store.startLook({ question: null });
    expect(last(none.state).html).toBe('<p>Map looks aren’t available in this viewer.</p>');
  });
});

describe('Map Buddy store: automations and the panel', () => {
  it('loads the palette; running one needs a parcel, sends its params, and says what ran or why not', async () => {
    const { store, state, sent } = setup({ routes: { workflows: json(200, { workflows: [{ id: 'check_buildability' }] }), workflow: json(200, { commands: [{ type: 'draw_parcel_buffer' }] }) } });
    await store.loadAutomations();
    expect(state.automations).toEqual([{ id: 'check_buildability' }]);
    await store.runAutomation('check_buildability');
    expect(last(state).html).toBe('<p>Select a parcel first, then I can run that on it.</p>');
    store.setParcel({ pin: '80-01' });
    await store.runAutomation('check_buildability', { setback_ft: 30 });
    expect(sent.workflow[0]).toMatchObject({ workflow: 'check_buildability', pin: '80-01', params: { setback_ft: 30 } });
    expect(last(state)).toMatchObject({ html: '<p>Ran Check buildability.</p>', chips: ['draw_parcel_buffer'] });

    const refused = setup({ routes: { workflow: json(200, { commands: [], note: 'Setback out of range.' }) } });
    refused.store.setParcel({ pin: '80-01' });
    await refused.store.runAutomation('x');
    expect(last(refused.state).html).toBe('<p>Setback out of range.</p>');
  });

  it('opens and collapses, remembering which; restores the width within its limits; mobile starts collapsed', () => {
    const storage = memoryStorage({ 'mb:collapsed': 'false', 'mb:width': '9999' });
    const { store, state } = setup({ storage });
    store.restore();
    expect(state).toMatchObject({ open: true, width: 620 });
    store.collapse();
    expect(storage.getItem('mb:collapsed')).toBe('true');
    store.setWidth(100);
    store.saveWidth();
    expect(storage.getItem('mb:width')).toBe('240');
    const phone = setup({ storage: memoryStorage({ 'mb:collapsed': 'false' }), mobile: true });
    phone.store.restore();
    expect(phone.state.open).toBe(false);
  });

  it('the placeholder and context follow the parcel, but not mid-turn', () => {
    const { store, state } = setup();
    expect(state.placeholder).toBe('Ask about this parcel or search by owner…');
    store.setParcel({ pin: '80-01' });
    expect(state.placeholder).toBe('Ask about parcel 80-01…');
    state.streaming = true;
    store.setParcel(null);
    expect(state.placeholder).toBe('Ask about parcel 80-01…');
    expect(contextText({ pin: '80-01', acres: 12.34, owner_name: 'John Q Smith' })).toBe('80-01 · 12.3 ac · John Q');
    expect(starterIdeas(null)).toHaveLength(3);
    expect(suggestionItems([{}, null])).toEqual([]);
  });
});

// ── The component ─────────────────────────────────────────────────────────────
describe('MapBuddyPanel', () => {
  function panel(opts) {
    const s = setup(opts);
    const w = mount(MapBuddyPanel, { props: { store: s.store }, attachTo: document.body });
    return { ...s, w };
  }

  it('keeps the labels, roles and ids the page, its CSS and the e2e suite use', () => {
    const { w } = panel();
    expect(w.get('#mb-resize-handle').attributes()).toMatchObject({ role: 'separator', 'aria-label': 'Drag to resize MapBuddy A.I. panel' });
    expect(w.get('#mb-tab-btn').attributes('aria-label')).toBe('Open MapBuddy A.I. panel');
    expect(w.get('#mb-messages').attributes()).toMatchObject({ role: 'log', 'aria-live': 'polite', 'aria-label': 'MapBuddy A.I. conversation' });
    expect(w.get('#mb-input').attributes()).toMatchObject({ 'aria-label': 'Message MapBuddy A.I.', maxlength: '2000' });
    expect(w.get('#mb-send-btn').attributes('aria-label')).toBe('Send');
    expect(w.get('#mb-context').classes()).toContain('mb-context-empty');
    expect(w.get('#mb-automations').attributes('hidden')).toBeDefined();
    w.unmount();
  });

  it('Enter sends and clears; Shift+Enter does not; the buttons lock while a turn runs', async () => {
    let release;
    const { w, sent, store } = panel({ chat: [new Promise((r) => { release = r; })] });
    await w.get('#mb-input').setValue('Hello');
    await w.get('#mb-input').trigger('keydown', { key: 'Enter', shiftKey: true });
    expect(sent.chat).toHaveLength(0);
    await w.get('#mb-input').trigger('keydown', { key: 'Enter' });
    expect(sent.chat).toHaveLength(1);
    expect(w.get('#mb-input').element.value).toBe('');
    expect(w.get('#mb-send-btn').attributes('disabled')).toBeDefined();
    expect(w.get('#mb-look-btn').attributes('disabled')).toBeDefined();
    expect(w.get('[data-testid="mb-thinking"]').text()).toBe('Thinking…');
    release(streamed(sse(done('Hi there', { commands: [{ type: 'zoom_to' }], citations: [{ source_id: 'MCL 1', anchor: 'a', span: 's' }] }))));
    await flushPromises();
    expect(w.get('[data-testid="mb-msg-user"]').text()).toBe('Hello');
    const reply = w.get('[data-testid="mb-msg-ai"]');
    expect(reply.get('[data-testid="mb-msg-label"]').text()).toBe('MapBuddy A.I.');
    expect(reply.findAll('.mb-action-chip').map((c) => c.text())).toEqual(['zoom_to']);
    expect(reply.get('[data-testid="cite-trigger"]').attributes()).toMatchObject({ 'data-cite-source': 'MCL 1', 'data-cite-anchor': 'a', 'data-cite-span': 's' });
    expect(w.get('#mb-send-btn').attributes('disabled')).toBeUndefined();
    expect(store.state.streaming).toBe(false);
    w.unmount();
  });

  it('the welcome ideas ask; a parcel changes them and the context', async () => {
    const { w, store, sent } = panel();
    expect(w.findAll('.mb-quick-btn').map((b) => b.text())).toEqual(starterIdeas(null));
    store.setParcel({ pin: '80-01', acres: 3 });
    await flushPromises();
    expect(w.get('#mb-context-text').text()).toBe('80-01 · 3.0 ac');
    expect(w.get('.mb-empty-hint').text()).toContain('Parcel 80-01 is selected');
    await w.findAll('.mb-quick-btn')[0].trigger('click');
    await flushPromises();
    expect(sent.chat[0].message).toBe('Give me the rundown on this parcel');
    expect(w.find('.mb-empty-state').exists()).toBe(false);
    w.unmount();
  });

  it('suggestion chips and the look offer; a result button selects its parcel', async () => {
    const { w, ui, sent, cmd } = panel();
    ui.suggest([{ label: 'Measure', prompt: 'Measure it' }]);
    ui.results('<ul><li><button class="mb-result-btn" data-pin="80-02">80-02</button></li></ul>');
    ui.offerLook('Look?');
    await flushPromises();
    await w.get('.mb-suggest-chip').trigger('click');
    await flushPromises();
    expect(sent.chat[0].message).toBe('Measure it');
    await w.get('.mb-result-btn').trigger('click');
    expect(cmd.selectResult).toHaveBeenCalledWith('80-02');
    expect(w.get('.mb-look-chip').text()).toBe('Look at the map');
    w.unmount();
  });

  it('the automations palette opens, takes its params, and runs on the parcel', async () => {
    const { w, store, sent } = panel({ routes: {
      workflows: json(200, { workflows: [{ id: 'check_buildability', description: 'Setback and buildable area', params: { setback_ft: { default: 25 } } }] }),
      workflow: json(200, { commands: [{ type: 'draw_parcel_buffer' }] }),
    } });
    await store.loadAutomations();
    store.setParcel({ pin: '80-01' });
    await flushPromises();
    expect(w.get('#mb-automations').attributes('hidden')).toBeUndefined();
    expect(w.get('#mb-auto-body').attributes('hidden')).toBeDefined();
    await w.get('#mb-auto-toggle').trigger('click');
    expect(w.get('#mb-auto-toggle').attributes('aria-expanded')).toBe('true');
    expect(w.get('.mb-auto-caret').text()).toBe('▾');
    const inp = w.get('.mb-auto-input');
    expect(inp.attributes('aria-label')).toBe('Setback ft for Check buildability');
    expect(inp.element.value).toBe('25');
    await inp.setValue('40');
    await w.get('.mb-auto-run').trigger('click');
    await flushPromises();
    expect(sent.workflow[0].params).toEqual({ setback_ft: 40 });
    expect(w.findAll('[data-testid="mb-msg-body"]').at(-1).text()).toBe('Ran Check buildability.');
    w.unmount();
  });

  it('drag-resizes from the handle while open, and saves the width', async () => {
    const storage = memoryStorage();
    const { w, store } = panel({ storage });
    store.open();
    await w.get('#mb-resize-handle').trigger('mousedown', { clientX: 1000 });
    expect(store.state.resizing).toBe(true);
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 900 }));
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(store.state.resizing).toBe(false);
    expect(store.state.width).toBe(440);   // 340 + 100 (offsetWidth is 0 in happy-dom, so it starts from the state)
    expect(storage.getItem('mb:width')).toBe('440');
    w.unmount();
  });
});
