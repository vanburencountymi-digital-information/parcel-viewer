<!-- The inside of the Map Control Panel: a draggable header (the active tab's name, and × to
     hide the panel), the tab strip with the Advanced toggle, and the body. The panes are
     the page's own elements, moved in as they are (classic scripts wired them before this
     mounted), and shown one at a time. The panel element itself stays the page's: Map
     Buddy, the mobile tab bar and hints show it directly. -->
<script setup>
import { onMounted, ref, watch } from 'vue';

const props = defineProps({
  store: { type: Object, required: true },
  host: { type: Object, required: true },     // #map-control-panel
  panes: { type: Object, required: true },    // tab id → its pane element
});
const state = props.store.state;
const body = ref(null);

onMounted(() => {
  for (const t of props.store.tabs) {
    const pane = props.panes[t.id];
    if (pane) body.value.appendChild(pane);
  }
});

// One pane at a time; a gated tab's pane never shows.
watch(() => state.tab, (tab) => {
  for (const t of props.store.tabs) {
    const pane = props.panes[t.id];
    if (pane) pane.hidden = t.gated || t.id !== tab;
  }
}, { immediate: true, flush: 'post' });

// The advanced tabs show while the panel has this class (style.css).
watch(() => state.advanced, (on) => props.host.classList.toggle('mcp-show-advanced', on), { immediate: true });

function close() {
  props.host.hidden = true;
  const reopen = document.getElementById('mcp-reopen-tab');
  if (reopen) reopen.hidden = false;
  if (window.PV_MOBILE_TABS) window.PV_MOBILE_TABS.refresh();
}

// ── Dragging by the header ─────────────────────────────────────────────────
let drag = null;
function dragStart(e) {
  if (e.target.closest('.mcp-header-close')) return;
  const el = props.host;
  e.currentTarget.setPointerCapture(e.pointerId);
  const rect = el.getBoundingClientRect();
  drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
  el.style.bottom = 'auto';
  el.style.right = 'auto';
  el.style.left = rect.left + 'px';
  el.style.top = rect.top + 'px';
}
function dragMove(e) {
  if (!drag) return;
  const el = props.host;
  const area = el.parentElement.getBoundingClientRect();
  el.style.left = Math.max(0, Math.min(area.width - el.offsetWidth, drag.left - area.left + e.clientX - drag.x)) + 'px';
  el.style.top = Math.max(0, Math.min(area.height - el.offsetHeight, drag.top - area.top + e.clientY - drag.y)) + 'px';
}
function dragEnd() { drag = null; }
</script>

<template>
  <div
    id="mcp-header"
    class="mcp-header"
    @pointerdown="dragStart"
    @pointermove="dragMove"
    @pointerup="dragEnd"
    @pointercancel="dragEnd"
  >
    <span id="mcp-header-title" class="mcp-header-title" role="heading" aria-level="2">{{ store.title.value }}</span>
    <button id="mcp-header-close" class="mcp-header-close" title="Hide panel" aria-label="Hide panel" @click="close">&#x2715;</button>
  </div>
  <div class="mcp-main">
    <nav class="mcp-tabs" aria-label="Map tools">
      <!-- Only the tabs are in the tablist; the Advanced toggle is a sibling (ARIA: a
           tablist may contain only tabs). display:contents keeps the layout. -->
      <div class="mcp-tablist" role="tablist" aria-label="Map tool tabs">
        <button
          v-for="t in store.tabs"
          v-show="!t.gated"
          :key="t.id"
          class="mcp-tab"
          :class="{ active: state.tab === t.id }"
          :data-tab="t.id"
          :data-advanced="t.advanced ? 'true' : null"
          :title="t.title"
          :aria-label="t.title"
          role="tab"
          :aria-selected="String(state.tab === t.id)"
          :aria-controls="`mcp-pane-${t.id}`"
          @click="store.setTab(t.id)"
        >
          <svg v-if="t.id === 'layers'" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <rect x="1" y="2" width="14" height="2.5" rx="1" />
            <rect x="1" y="6.75" width="14" height="2.5" rx="1" />
            <rect x="1" y="11.5" width="14" height="2.5" rx="1" />
          </svg>
          <svg v-else-if="t.id === 'select'" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <rect x="2" y="2" width="9" height="9" rx="1" stroke-dasharray="2.5 1.5" />
            <line x1="11" y1="11" x2="14.5" y2="14.5" stroke-linecap="round" stroke-width="2" />
          </svg>
          <svg v-else-if="t.id === 'draw'" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2.5 13L5 14.5l7.5-9.5-2-1.5L2.5 13z" />
            <path d="M2.5 13l-1.5 2.5 2.5-1" />
            <line x1="10.5" y1="3" x2="12.5" y2="4.5" />
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
            <line x1="1" y1="8" x2="15" y2="8" />
            <line x1="1" y1="5" x2="1" y2="11" />
            <line x1="15" y1="5" x2="15" y2="11" />
            <line x1="5" y1="6.5" x2="5" y2="9.5" />
            <line x1="8" y1="6" x2="8" y2="10" />
            <line x1="11" y1="6.5" x2="11" y2="9.5" />
          </svg>
        </button>
      </div>
      <button
        id="mcp-advanced-toggle"
        class="mcp-adv-toggle"
        type="button"
        :title="state.advanced ? 'Hide advanced tools' : 'Advanced tools'"
        :aria-pressed="String(state.advanced)"
        aria-label="Show advanced tools"
        @click="store.setAdvanced(!state.advanced)"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
          <line x1="2" y1="5" x2="14" y2="5" /><line x1="2" y1="11" x2="14" y2="11" />
          <circle cx="6" cy="5" r="1.7" fill="currentColor" stroke="none" /><circle cx="10" cy="11" r="1.7" fill="currentColor" stroke="none" />
        </svg>
      </button>
    </nav>
    <div ref="body" class="mcp-body"></div>
  </div>
</template>
