<!-- Map Buddy's panel (DIC-2389; was the HTML map-buddy.js built): the resize handle, the
     tab that opens it, the mobile drawer handle, and inside: the header, the parcel context
     with "Describe this view", the automations palette, the conversation, and the composer.
     Mounted inside #map-buddy-panel, whose classes (mb-collapsed, mb-resizing) and width the
     island keeps (index.js). Same ids, classes, labels and test ids as before. -->
<script setup>
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { humanize } from './markdown.js';
import { starterIdeas, contextText } from './store.js';

const props = defineProps({
  store: { type: Object, required: true },
  isMobile: { type: Function, default: () => false },
  doc: { type: Object, default: () => document },
});
const state = props.store.state;
const messages = ref(null);
const input = ref(null);

// ── The composer ─────────────────────────────────────────────────────────────
function grow() {
  const el = input.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(100, el.scrollHeight) + 'px';
}
function send() {
  props.store.send();
  if (input.value && !state.draft) input.value.style.height = '';
}
function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
}
const ask = (text) => { props.store.send(text); };

// Keep the newest message in view.
watch(() => [state.messages.length, state.messages.map((m) => m.text || m.chips && m.chips.length).join()], async () => {
  await nextTick();
  if (messages.value) messages.value.scrollTop = messages.value.scrollHeight;
}, { flush: 'post' });

// ── Drag-resize (desktop) ────────────────────────────────────────────────────
let startX = 0;
let startW = 0;
const panelEl = () => messages.value && messages.value.closest('#map-buddy-panel');
function startResize(e) {
  if (!state.open || props.isMobile()) return;
  state.resizing = true;
  startX = e.clientX;
  startW = panelEl() ? panelEl().offsetWidth : state.width;
  props.doc.body.style.cursor = 'col-resize';
  props.doc.body.style.userSelect = 'none';
  const map = props.doc.getElementById('map');
  if (map) map.style.pointerEvents = 'none';
  e.preventDefault();
}
function onMove(e) {
  if (state.resizing) props.store.setWidth(startW + (startX - e.clientX));
}
function onUp() {
  if (!state.resizing) return;
  state.resizing = false;
  props.doc.body.style.cursor = '';
  props.doc.body.style.userSelect = '';
  const map = props.doc.getElementById('map');
  if (map) map.style.pointerEvents = '';
  props.store.saveWidth();
}
onMounted(() => {
  props.doc.addEventListener('mousemove', onMove);
  props.doc.addEventListener('mouseup', onUp);
});
onUnmounted(() => {
  props.doc.removeEventListener('mousemove', onMove);
  props.doc.removeEventListener('mouseup', onUp);
});

// ── Automations palette ──────────────────────────────────────────────────────
const autoOpen = ref(false);
const autoParams = ref({});   // { [workflow id]: { [param]: value } }
function paramValue(wf, k) {
  const vals = autoParams.value[wf.id] || {};
  if (k in vals) return vals[k];
  const d = (wf.params || {})[k] || {};
  return d.default !== undefined && d.default !== null ? d.default : '';
}
function setParam(wf, k, v) { autoParams.value = { ...autoParams.value, [wf.id]: { ...(autoParams.value[wf.id] || {}), [k]: v } }; }
function runAutomation(wf) {
  const params = {};
  for (const k of Object.keys(wf.params || {})) {
    const v = parseFloat(paramValue(wf, k));
    if (!Number.isNaN(v)) params[k] = v;
  }
  props.store.runAutomation(wf.id, params);
}

// A result list's buttons select that parcel and fly to it.
function onInfoClick(e) {
  const b = e.target.closest('.mb-result-btn');
  if (b) props.store.selectResult(b.getAttribute('data-pin'));
}
</script>

<template>
  <div id="mb-resize-handle" class="mb-resize-handle" role="separator" aria-label="Drag to resize MapBuddy A.I. panel" @mousedown="startResize"></div>
  <button id="mb-tab-btn" class="mb-tab-btn" title="Open MapBuddy A.I." aria-label="Open MapBuddy A.I. panel" @click="store.open()">
    <span>MapBuddy A.I.</span>
  </button>
  <div class="mb-drawer-handle" @click="store.toggle()">
    <div class="mb-drawer-pill"></div>
    <span class="mb-drawer-label">MapBuddy A.I.</span>
    <div class="mb-drawer-pill"></div>
    <button id="mb-mobile-close" class="mb-mobile-close" title="Close" aria-label="Close MapBuddy A.I." @click.stop="store.collapse()">✕</button>
  </div>
  <div class="mb-inner">
    <div class="mb-header">
      <span class="mb-header-title">MapBuddy A.I.</span>
      <button id="mb-collapse-btn" class="mb-collapse-btn" title="Collapse panel" aria-label="Collapse MapBuddy A.I." @click="store.collapse()">❮</button>
    </div>
    <div id="mb-context" class="mb-context" :class="{ 'mb-context-empty': !state.parcel }">
      <span class="mb-context-dot"></span>
      <span id="mb-context-text">{{ contextText(state.parcel) }}</span>
      <button id="mb-look-btn" class="mb-look-btn" type="button" title="An AI image model describes the map as you see it"
              :disabled="state.streaming" @click="store.startLook({ question: null, userLabel: 'Describe this view' })">Describe this view</button>
    </div>

    <div id="mb-automations" class="mb-automations" :hidden="!state.automations">
      <template v-if="state.automations">
        <button id="mb-auto-toggle" type="button" class="mb-auto-toggle" :aria-expanded="String(autoOpen)" aria-controls="mb-auto-body" @click="autoOpen = !autoOpen">
          <span class="mb-auto-caret">{{ autoOpen ? '▾' : '▸' }}</span><span>Automations</span>
        </button>
        <div id="mb-auto-body" class="mb-auto-body" data-testid="mb-auto-body" :hidden="!autoOpen">
          <div v-for="wf in state.automations" :key="wf.id" class="mb-auto-row" :data-wf="wf.id">
            <button type="button" class="mb-auto-run" :data-wf="wf.id" :title="wf.description" @click="runAutomation(wf)">{{ humanize(wf.id) }}</button>
            <span v-if="Object.keys(wf.params || {}).length" class="mb-auto-params">
              <label v-for="k in Object.keys(wf.params || {})" :key="k" class="mb-auto-param">{{ humanize(k) }}
                <input type="number" class="mb-auto-input" :data-param="k" :value="paramValue(wf, k)"
                       :aria-label="humanize(k) + ' for ' + humanize(wf.id)" @input="setParam(wf, k, $event.target.value)">
              </label>
            </span>
            <span class="mb-auto-desc">{{ wf.description }}</span>
          </div>
        </div>
      </template>
    </div>

    <div id="mb-messages" ref="messages" class="mb-messages" role="log" aria-live="polite" aria-label="MapBuddy A.I. conversation">
      <div v-if="state.welcome" class="mb-empty-state">
        <div class="mb-empty-title">MapBuddy A.I.</div>
        <div v-if="state.parcel && state.parcel.pin" class="mb-empty-hint">Parcel <strong>{{ state.parcel.pin }}</strong> is selected — want me to dig in? Tap an idea, or ask anything.</div>
        <div v-else class="mb-empty-hint">Your A.I. assistant — I can drive the map for you. Select a parcel and tap an idea below, or just ask.</div>
        <div class="mb-quick-btns">
          <button v-for="idea in starterIdeas(state.parcel)" :key="idea" class="mb-quick-btn" @click="ask(idea)">{{ idea }}</button>
        </div>
      </div>

      <template v-for="m in state.messages" :key="m.id">
        <div v-if="m.kind === 'user'" class="mb-msg-user" data-testid="mb-msg-user">{{ m.text }}</div>

        <div v-else-if="m.kind === 'ai'" class="mb-msg-ai" data-testid="mb-msg-ai">
          <div class="mb-msg-ai-label" data-testid="mb-msg-label">{{ m.label }}</div>
          <!-- Markdown escaped first (markdown.js): no raw HTML from the model. -->
          <div class="mb-msg-ai-body" data-testid="mb-msg-body" v-html="m.html"></div>
          <div v-if="m.chips.length" class="mb-action-chips">
            <span v-for="(c, i) in m.chips" :key="i" class="mb-action-chip">{{ c }}</span>
          </div>
          <!-- Each carries the data-cite-* envelope pv-citations.js listens for: a click opens
               the Sources panel at the passage (DIC-522). -->
          <div v-if="m.citations.length" class="mb-sources">
            <span class="mb-sources-label">Sources</span>
            <button v-for="(c, i) in m.citations" :key="i" type="button" class="pv-cite-trigger mb-source" data-testid="cite-trigger"
                    :data-cite-source="c.source_id || ''" :data-cite-anchor="c.anchor || ''" :data-cite-span="c.span || ''">{{ c.source_id || c.span || 'Source' }}</button>
          </div>
        </div>

        <div v-else-if="m.kind === 'thinking'" class="mb-thinking" data-testid="mb-thinking">
          {{ m.text }} <span class="mb-thinking-dots"><span class="mb-thinking-dot"></span><span class="mb-thinking-dot"></span><span class="mb-thinking-dot"></span></span>
        </div>

        <!-- The read of a look, labelled so it's never mistaken for a record (DIC-2135). -->
        <div v-else-if="m.kind === 'vision'" class="mb-msg-ai mb-msg-vision" data-testid="mb-msg-vision">
          <div class="mb-msg-ai-label" data-testid="mb-msg-label">AI visual read of the current map view</div>
          <div class="mb-msg-ai-body" data-testid="mb-msg-body" v-html="m.html"></div>
          <div class="mb-vision-meta" data-testid="mb-vision-meta">{{ m.meta }}</div>
        </div>

        <!-- Measurements, search results, tour notes: HTML built by map-buddy-commands.js,
             every value escaped. -->
        <div v-else-if="m.kind === 'info'" class="mb-msg-ai mb-msg-info" data-testid="mb-msg-info" @click="onInfoClick">
          <div class="mb-msg-ai-body" data-testid="mb-msg-body" v-html="m.html"></div>
        </div>

        <div v-else-if="m.kind === 'suggest'" class="mb-suggest-row">
          <button v-for="(it, i) in m.items" :key="i" class="mb-suggest-chip" @click="ask(it.prompt)">{{ it.label }}</button>
        </div>

        <!-- The AI's single look offer: nothing is spent unless it's tapped. -->
        <div v-else-if="m.kind === 'lookOffer'" class="mb-suggest-row mb-look-offer">
          <button type="button" class="mb-suggest-chip mb-look-chip" @click="store.acceptLookOffer(m)">Look at the map</button>
        </div>
      </template>
    </div>

    <div class="mb-input-area">
      <textarea id="mb-input" ref="input" v-model="state.draft" class="mb-input" rows="1" maxlength="2000"
                :placeholder="state.placeholder" aria-label="Message MapBuddy A.I." @input="grow" @keydown="onKeydown"></textarea>
      <button id="mb-send-btn" class="mb-send-btn" aria-label="Send" :disabled="state.streaming" @click="send">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor" aria-hidden="true"><path d="M1.5 6.5 L11.5 1 L8.5 6.5 L11.5 12 Z" /></svg>
      </button>
    </div>
  </div>
</template>
