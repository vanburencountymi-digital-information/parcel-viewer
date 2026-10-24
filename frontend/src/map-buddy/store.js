// Map Buddy's panel state and conversation (moved from map-buddy.js in DIC-2389): whether
// the panel is open and how wide, the parcel it's about, the messages, and the turns: a
// chat turn streamed from /chat (SSE), a look at the map (DIC-2135: capture → /vision/
// describe → one more turn answering from it), and the automations palette (DIC-432:
// /workflows, /workflow). The map commands a reply carries run in map-buddy-commands.js,
// created here with this store as their adapter. Collaborators are injected so Vitest can
// drive it.
import { reactive } from 'vue';
import { deIcon, escHtml, humanize, renderMarkdown } from './markdown.js';

export const STORAGE_COLLAPSED = 'mb:collapsed';
export const STORAGE_WIDTH = 'mb:width';
export const DEFAULT_WIDTH = 340;
export const MIN_WIDTH = 240;
export const MAX_WIDTH = 620;
// Chat request ceiling and per-turn history cap (the server rejects turns over 8000 chars).
const CHAT_TIMEOUT_MS = 120000;
const HISTORY_MAX_CHARS = 6000;

const STATIC_PLACEHOLDER = 'Ask about this parcel or search by owner…';

/** What a failed /chat request says, by its error. */
export function chatFailureText(err) {
  const st = err && err.status;
  if (err && err.name === 'AbortError') return 'That took too long, so I stopped waiting. Please try again.';
  if (st === 404) return 'The AI backend isn’t connected yet. Check back soon!';
  if (st === 429) return 'Map Buddy is busy right now. Please wait a moment and try again.';
  if (st === 413 || st === 422) return 'That request was too long for Map Buddy. Try a shorter message.';
  return 'Couldn’t reach the server. Please try again.';
}

export function visionFailureText(status, data) {
  if (status === 429) return 'You’ve reached the limit for map looks for now. Please try again later.';
  if (data && data.degraded) return 'Map looks are paused for now because the AI limit was reached.';
  if (status === 400 && data && data.error) return 'Couldn’t analyse the map view: ' + data.error;
  return 'Couldn’t analyse the map view. Please try again in a moment.';
}

/** The welcome screen's ideas: parcel workflows with a parcel, else navigation and search. */
export function starterIdeas(parcel) {
  if (parcel && parcel.pin) {
    return [
      'Give me the rundown on this parcel',
      'Is ' + parcel.pin + ' at risk of flooding or wetlands?',
      'Draw a 30 ft setback and show the buildable area',
      'How big is it, with dimensions?',
    ];
  }
  return ['Find a parcel by owner name or address', 'Tilt the map to 3-D with terrain shading', 'What can you do?'];
}

/** The context pill's text, e.g. "80-01-001 · 12.5 ac · John Smith". */
export function contextText(p) {
  if (!p) return 'No parcel selected';
  const acres = p.acres != null ? ' · ' + p.acres.toFixed(1) + ' ac' : '';
  const owner = p.owner_name ? ' · ' + p.owner_name.split(' ').slice(0, 2).join(' ') : '';
  return p.pin + acres + owner;
}

/** AI-offered next steps: strings or { label, prompt }, at most four, icons dropped. */
export function suggestionItems(list) {
  return (list || []).map((s) => {
    if (typeof s === 'string') return s.trim() ? { label: s, prompt: s } : null;
    if (s && s.label) return { label: s.label, prompt: s.prompt || s.label };
    return null;
  }).filter(Boolean).slice(0, 4).map((it) => ({ label: deIcon(it.label), prompt: it.prompt }));
}

function visionMeta(data, now) {
  const when = data.at ? new Date(data.at) : now();
  const time = Number.isNaN(when.getTime()) ? '' : when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const layers = (data.layers || []).join(', ');
  const incomplete = (data.layers_incomplete || []).join(', ');
  return (layers ? 'Layers: ' + layers : 'Base map only') +
    (incomplete ? ' (not fully loaded: ' + incomplete + ')' : '') + (time ? ' · ' + time : '') +
    ' · An interpretation of the imagery, not a survey or tax record';
}

export function createMapBuddyStore({
  fetch, apiBase, storage, commands, vision = () => null, map = () => null,
  citationsEnabled = () => true, host = {}, isMobile = () => false, now = () => new Date(),
  timers = globalThis, log = console,
}) {
  const state = reactive({
    open: false,
    width: DEFAULT_WIDTH,
    resizing: false,
    parcel: null,            // the parcel Map Buddy is talking about
    placeholder: STATIC_PLACEHOLDER,
    draft: '',               // the composer's text
    streaming: false,        // a turn (chat or look) is running: the composer is locked
    welcome: true,           // the welcome screen shows until the first turn
    messages: [],            // { id, kind, … } — see push()
    automations: null,       // the palette's workflows, once /workflows answers with some
  });
  let nextId = 1;
  let history = [];
  let pendingLook = null;    // a look the AI asked for, run once its reply is on screen
  let visionOffered = false; // the AI offers a look at most once per conversation (each is a paid call)

  // Message kinds: user { text }, ai { html, label, chips, citations }, thinking { text },
  // vision { html, meta }, info { html }, suggest { items }, lookOffer { question }.
  function push(kind, props) {
    const m = { id: nextId++, kind, ...props };
    state.messages.push(m);
    return state.messages[state.messages.length - 1];
  }
  const remove = (m) => { const i = state.messages.indexOf(m); if (i !== -1) state.messages.splice(i, 1); };
  const ai = (text) => push('ai', { html: renderMarkdown(text), label: 'MapBuddy A.I.', chips: [], citations: [] });
  const thinking = (text = 'Thinking…') => push('thinking', { text });

  // ── The map commands, with this store as their adapter ────────────────────
  const cmd = commands({
    currentParcel: () => state.parcel,
    info: (html) => push('info', { html }),
    results: (html) => push('info', { html }),
    suggest: (list) => { const items = suggestionItems(list); if (items.length) push('suggest', { items }); },
    requestLook: (question) => { pendingLook = { question }; },
    offerLook: (question) => {
      if (visionOffered) return;   // never a second offer in one conversation
      visionOffered = true;
      push('lookOffer', { question });
    },
  });
  const chipsOf = (labels) => labels.map(deIcon);

  // ── The panel ──────────────────────────────────────────────────────────────
  function persist(key, value) { try { storage().setItem(key, value); } catch { /* storage blocked */ } }
  function restore() {
    let saved = NaN;
    try { saved = parseInt(storage().getItem(STORAGE_WIDTH), 10); } catch { /* blocked */ }
    if (saved && !Number.isNaN(saved)) state.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, saved));
    let wasOpen = false;
    try { wasOpen = storage().getItem(STORAGE_COLLAPSED) === 'false'; } catch { /* blocked */ }
    // On mobile, always start collapsed (the tab bar reopens it), so the viewer loads with
    // every panel closed. Desktop restores the saved state.
    if (!isMobile() && wasOpen) open(); else collapse();
  }
  function open() {
    state.open = true;
    persist(STORAGE_COLLAPSED, 'false');
    if (host.changed) host.changed(state);
  }
  function collapse() {
    state.open = false;
    persist(STORAGE_COLLAPSED, 'true');
    if (host.changed) host.changed(state);
  }
  const toggle = () => (state.open ? collapse() : open());
  function setWidth(w) {
    state.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));
    if (host.changed) host.changed(state);
  }
  const saveWidth = () => persist(STORAGE_WIDTH, String(state.width));

  function setParcel(p) {
    state.parcel = p || null;
    if (!state.streaming) state.placeholder = p ? 'Ask about parcel ' + p.pin + '…' : 'Ask me to find a parcel, or ask a general question…';
  }

  // ── A chat turn ────────────────────────────────────────────────────────────
  function parcelContext() {
    const p = state.parcel;
    return { pin: p.pin, acres: p.acres, owner_name: p.owner_name, site_address: p.site_address, municipality: p.municipality, centroid: p.centroid, bbox: p.bbox };
  }

  function lock(run) {
    state.streaming = true;
    const unlock = () => { state.streaming = false; };
    return run().then(unlock, unlock);
  }

  /** Sends the composer's text (or `text`). Nothing while a turn runs, or when empty. */
  function send(text) {
    if (text != null) state.draft = text;
    const msg = state.draft.trim();
    if (!msg || state.streaming) return Promise.resolve();
    state.welcome = false;
    push('user', { text: msg });
    state.draft = '';
    return lock(() => streamChat(msg));
  }

  // opts.visionRead: the look this turn answers from (DIC-2135).
  async function streamChat(userMessage, opts = {}) {
    const think = thinking();
    const payload = {
      message: userMessage,
      conversation_history: history.slice(-12),
      parcel_context: state.parcel ? parcelContext() : null,
      map_state: cmd.buildMapState(),
      vision_offered: visionOffered,
    };
    if (opts.visionRead) payload.vision_read = opts.visionRead;
    // A request can legitimately take a while (several tool rounds), but never forever:
    // abort, so Send and "Thinking…" can't stay stuck (DIC-1870).
    const ctrl = new AbortController();
    const timer = timers.setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
    let finished = false;   // a 'done' or 'error' event arrived
    try {
      const res = await fetch(apiBase() + '/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl.signal,
      });
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (line.indexOf('data: ') !== 0) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          let evt;
          try { evt = JSON.parse(raw); } catch { continue; }
          if (evt.type === 'status') {
            think.text = evt.message;
          } else if (evt.type === 'done') {
            finished = true;
            remove(think);
            const responseText = evt.response_text || '';
            const reply = ai(responseText);
            // Keep only turns the server accepts when resent: an empty turn, or one over
            // the cap, would make every later request fail (DIC-1870).
            if (responseText.trim()) {
              history.push({ role: 'user', content: userMessage.slice(0, HISTORY_MAX_CHARS) });
              history.push({ role: 'assistant', content: responseText.slice(0, HISTORY_MAX_CHARS) });
            }
            if (evt.commands && evt.commands.length) reply.chips = chipsOf(cmd.run(evt.commands));
            if (evt.citations && evt.citations.length && citationsEnabled()) reply.citations = evt.citations;
          } else if (evt.type === 'error') {
            finished = true;
            remove(think);
            ai('Sorry, something went wrong: ' + evt.message);
          }
        }
      }
      // The stream closed without a final event: don't leave a dead "Thinking…".
      if (!finished) { remove(think); ai('Map Buddy stopped before finishing. Please try again.'); }
    } catch (err) {
      remove(think);
      ai(chatFailureText(err));
      log.error('[Map Buddy]', err);
    } finally {
      timers.clearTimeout(timer);
    }
    // The AI asked to look (look_at_map): run it now its reply is on screen; the answer
    // follows as one more turn, so the user never has to ask again.
    const look = pendingLook;
    pendingLook = null;
    if (look) await lookAtMap(look);
  }

  // ── A look at the map (DIC-2135) ───────────────────────────────────────────
  function visibleLayerLabels() {
    const ms = cmd.buildMapState() || {};
    if (ms.layers && ms.layers.length) {
      return ms.layers.filter((l) => l && l.visible).map((l) => String(l.label || l.id || '')).filter(Boolean).slice(0, 40);
    }
    return (ms.visible_layers || []).map(String).slice(0, 40);
  }

  /**
   * A look the user asked for (the panel button, an accepted offer, the right-click menu):
   * one at a time, with the composer locked like a send.
   */
  function startLook(look) {
    if (state.streaming) return Promise.resolve();
    state.welcome = false;
    if (look.userLabel) push('user', { text: look.userLabel });
    return lock(() => lookAtMap(look));
  }

  async function lookAtMap(look) {
    const think = thinking('Looking at the map…');
    const layers = visibleLayerLabels();
    const p = state.parcel;
    const v = vision();
    if (!v) { remove(think); ai('Map looks aren’t available in this viewer.'); return; }
    cmd.cancelCinematic();   // Map Buddy's own fly-around; pv-vision stops the map's
    let status = 0;
    try {
      const img = await v.capture(map());
      const res = await fetch(apiBase() + '/vision/describe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: img.data,
          media_type: img.media_type,
          view_width_ft: img.view_width_ft || null,
          question: look.question || null,
          parcel: p ? { pin: p.pin, site_address: p.site_address, acres: p.acres, municipality: p.municipality } : null,
          layers,
          // Overlays still loading or failing at capture (DIC-2144), so the model doesn't
          // read "no wetlands" from a layer that hadn't drawn.
          layers_incomplete: img.incomplete && img.incomplete.length ? img.incomplete.slice(0, 40) : null,
        }),
      });
      status = res.status;
      let data = null;
      try { data = await res.json(); } catch { /* not JSON */ }
      remove(think);
      if (status !== 200 || !data || !data.ok || !data.description) { ai(visionFailureText(status, data)); return; }
      // The read itself, labelled so it's never mistaken for a record. Same safe Markdown
      // as replies: the model sometimes bolds its best guess (DIC-2138).
      push('vision', { html: renderMarkdown(String(data.description || '')), meta: visionMeta(data, now) });
      await streamChat(look.question || 'What do you see in the current map view?', {
        visionRead: { description: String(data.description).slice(0, 4000), layers: data.layers || layers },
      });
    } catch (err) {
      remove(think);
      ai(err && err.message && /map/i.test(err.message)
        ? 'Couldn’t analyse the map view: ' + err.message
        : 'Couldn’t analyse the map view. Please try again in a moment.');
      log.error('[Map Buddy] vision', err);
    }
  }

  /** Taps the AI's single look offer: it goes, and the look runs. */
  function acceptLookOffer(m) {
    remove(m);
    return startLook({ question: m.question || null, userLabel: 'Look at the map' });
  }

  // ── Automations (DIC-432) ──────────────────────────────────────────────────
  // A one-tap list of the backend's macro registry. Running one hits /workflow
  // (deterministic, no model round-trip) and runs the commands it returns. Without the
  // endpoint (e.g. not yet redeployed) the palette doesn't render, with no error.
  async function loadAutomations() {
    try {
      const r = await fetch(apiBase() + '/workflows');
      const data = r.ok ? await r.json() : null;
      const list = data && data.workflows;
      if (list && list.length) state.automations = list;
    } catch { /* endpoint absent → no palette */ }
  }

  async function runAutomation(wfId, params = {}) {
    if (!state.parcel || !state.parcel.pin) { ai('Select a parcel first, then I can run that on it.'); return; }
    try {
      const r = await fetch(apiBase() + '/workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: wfId, pin: state.parcel.pin, params, parcel_context: parcelContext() }),
      });
      const data = r.ok ? await r.json() : null;
      if (!data || !Array.isArray(data.commands)) { ai('Couldn’t run that automation.'); return; }
      // No commands: the server refused (e.g. a setback out of range); its note says why.
      if (!data.commands.length) { ai(data.note ? String(data.note) : 'Couldn’t run that automation.'); return; }
      const chips = chipsOf(cmd.run(data.commands));
      ai('Ran ' + humanize(wfId) + '.').chips = chips;
    } catch {
      ai('Couldn’t reach the server for that automation.');
    }
  }

  return {
    state, restore, open, collapse, toggle, setWidth, saveWidth, setParcel,
    send, startLook, acceptLookOffer, loadAutomations, runAutomation,
    selectResult: (pin) => cmd.selectResult(pin),
    runCommands: (cmds) => cmd.run(cmds),
    buildMapState: () => cmd.buildMapState(),
    escHtml,
  };
}
