<!-- The parcel info panel: a draggable region with the selection's title, a × that clears
     the selection, next/previous for a multi-parcel selection, and the card. Collapsed, it
     leaves a "Parcel Info" tab to reopen it. Labels with data-tip get a hover tooltip. -->
<script setup>
import { nextTick, reactive, ref } from 'vue';
import ParcelCard from '../parcel-card/ParcelCard.vue';

const props = defineProps({
  panel: { type: Object, required: true },
  card: { type: Object, required: true },
});
const state = props.panel.state;
const panelEl = ref(null);
defineExpose({ panelEl });

// The reopen tab shows the panel again and moves focus into it.
async function reopen() {
  props.panel.reopen();
  await nextTick();
  if (panelEl.value) panelEl.value.focus();
}

// ── Dragging by the header ─────────────────────────────────────────────────
let drag = null;   // { x, y, left, top } at pointerdown
function dragStart(e) {
  if (e.target.closest('.parcel-info-close')) return;
  const el = panelEl.value;
  e.currentTarget.setPointerCapture(e.pointerId);
  const rect = el.getBoundingClientRect();
  drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
  el.style.bottom = 'auto';
  el.style.left = rect.left + 'px';
  el.style.top = rect.top + 'px';
}
function dragMove(e) {
  if (!drag) return;
  const el = panelEl.value;
  // Kept inside the map area the panel is positioned in.
  const area = (el.offsetParent || el.parentElement).getBoundingClientRect();
  el.style.left = Math.max(0, Math.min(area.width - el.offsetWidth, drag.left - area.left + e.clientX - drag.x)) + 'px';
  el.style.top = Math.max(0, Math.min(area.height - el.offsetHeight, drag.top - area.top + e.clientY - drag.y)) + 'px';
}
function dragEnd() { drag = null; }

// ── Field tooltip: one fixed-position element on <body>, so the body's scrolling
// (overflow-y: auto) can't clip it ───────────────────────────────────────────
const tip = reactive({ text: '', visible: false, left: 0, top: 0 });
const tipEl = ref(null);
function tipOver(e) {
  const el = e.target.closest('[data-tip]');
  if (!el) return;
  tip.text = el.dataset.tip;
  tip.visible = true;
}
function tipMove(e) {
  if (!tip.visible) return;
  // Above the cursor, kept inside the viewport.
  const tw = (tipEl.value && tipEl.value.offsetWidth) || 220;
  const th = (tipEl.value && tipEl.value.offsetHeight) || 40;
  let x = e.clientX + 12;
  let y = e.clientY - th - 8;
  if (x + tw > window.innerWidth - 8) x = e.clientX - tw - 12;
  if (y < 8) y = e.clientY + 20;
  tip.left = x;
  tip.top = y;
}
function tipOut(e) {
  if (e.target.closest('[data-tip]')) tip.visible = false;
}
</script>

<template>
  <button
    id="parcel-info-reopen-tab"
    class="parcel-info-reopen-tab"
    :hidden="state.view !== 'collapsed'"
    title="Open parcel info"
    aria-label="Open parcel info"
    @click="reopen"
  >
    Parcel Info
  </button>

  <div
    id="parcel-info-panel"
    ref="panelEl"
    class="parcel-info-panel"
    role="region"
    aria-labelledby="parcel-info-title"
    tabindex="-1"
    :hidden="state.view !== 'open'"
  >
    <div
      class="parcel-info-header"
      @pointerdown="dragStart"
      @pointermove="dragMove"
      @pointerup="dragEnd"
      @pointercancel="dragEnd"
    >
      <span id="parcel-info-title" class="parcel-info-title" role="heading" aria-level="2">{{ state.title }}</span>
      <button class="parcel-info-close" title="Clear selection" aria-label="Clear selection" @click="panel.close()">✕</button>
    </div>
    <div id="parcel-info-nav" class="parcel-info-nav" :hidden="state.count < 2">
      <button id="parcel-nav-prev" class="parcel-nav-btn" title="Previous parcel" aria-label="Previous parcel" @click="panel.cycle(-1)">&#8249;</button>
      <span id="parcel-nav-label" class="parcel-nav-label" data-testid="parcel-nav-label">{{ state.index + 1 }} of {{ state.count }}</span>
      <button id="parcel-fly-btn" class="parcel-nav-fly" title="Fly to parcel" @click="panel.flyTo()">&#8982;</button>
      <button id="parcel-nav-next" class="parcel-nav-btn" title="Next parcel" aria-label="Next parcel" @click="panel.cycle(1)">&#8250;</button>
    </div>
    <div class="parcel-info-body" @mouseover="tipOver" @mousemove="tipMove" @mouseout="tipOut">
      <ParcelCard :store="card" />
    </div>
  </div>

  <Teleport to="body">
    <div
      id="parcel-tip"
      ref="tipEl"
      aria-hidden="true"
      :class="{ 'parcel-tip-visible': tip.visible }"
      :style="{ left: tip.left + 'px', top: tip.top + 'px' }"
    >{{ tip.text }}</div>
  </Teleport>
</template>
