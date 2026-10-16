<!-- The viewer's modal dialog, on <body>. While it's open: the rest of the page (#app) is
     inert and hidden from assistive technology, Esc and the backdrop close it, Tab stays
     inside, and on desktop it can be dragged by its header and resized from a corner.
     Closing returns focus to whatever opened it (DIC-373), or to the Help & tools button. -->
<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({ store: { type: Object, required: true } });
const state = props.store.state;
const dialog = ref(null);
const header = ref(null);
const body = ref(null);

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables() {
  if (!dialog.value) return [];
  return [...dialog.value.querySelectorAll(FOCUSABLE)]
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function onKey(e) {
  if (!state.open) return;
  if (e.key === 'Escape') { props.store.close(); return; }
  if (e.key !== 'Tab') return;
  const f = focusables();
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1], active = document.activeElement;
  const inside = dialog.value.contains(active);
  if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); }
}

function setPageInert(on) {
  const app = document.getElementById('app');
  if (!app) return;
  if (on) { app.setAttribute('inert', ''); app.setAttribute('aria-hidden', 'true'); }
  else { app.removeAttribute('inert'); app.removeAttribute('aria-hidden'); }
}

// Each open: hand the body to the opener, then focus the first field (or Close).
watch(() => state.open && state.key, async (opened) => {
  if (!opened) return;
  await nextTick();
  pinned = false;
  tx = 0; ty = 0;
  props.store.mounted(body.value);
  const first = dialog.value && dialog.value.querySelector('input, textarea, select, button.pv-modal-close');
  if (first) first.focus();
}, { flush: 'post' });

watch(() => state.open, (open) => {
  setPageInert(open);
  if (open) { document.addEventListener('keydown', onKey); return; }
  document.removeEventListener('keydown', onKey);
  // Back to the opener; if it's gone or hidden now (a menu item that closed with the
  // menu), to the Help & tools button, so focus never lands on <body>.
  const ret = props.store.takeReturnFocus();
  nextTick(() => {
    if (ret && document.contains(ret) && ret.offsetParent !== null) ret.focus();
    else { const b = document.getElementById('pv-admin-btn'); if (b) b.focus(); }
  });
});

onBeforeUnmount(() => { document.removeEventListener('keydown', onKey); setPageInert(false); });

// ── Drag and resize (desktop only) ─────────────────────────────────────────
// The size is pinned to what's on screen only once a drag or resize begins: pinning up
// front ran before the body's content arrived (Bookmarks builds its list on mount, What's
// New fetches), locking the dialog to its empty size.
let tx = 0, ty = 0, pinned = false;
const desktop = () => window.matchMedia && window.matchMedia('(min-width: 641px)').matches;
function pinSize() {
  if (pinned) return;
  const el = dialog.value;
  el.style.width = el.offsetWidth + 'px';
  el.style.height = el.offsetHeight + 'px';
  el.style.maxWidth = 'none';
  el.style.maxHeight = 'none';
  pinned = true;
}
function track(handle, e, move) {
  handle.setPointerCapture(e.pointerId);
  const up = () => {
    try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
}
function dragStart(e) {
  if (!desktop() || e.target.closest('button')) return;   // the close button still works
  e.preventDefault();
  pinSize();
  const sx = e.clientX, sy = e.clientY, ox = tx, oy = ty;
  track(header.value, e, (ev) => {
    tx = ox + (ev.clientX - sx);
    ty = oy + (ev.clientY - sy);
    dialog.value.style.transform = `translate(${tx}px,${ty}px)`;
  });
}
function resizeStart(e) {
  e.preventDefault();
  e.stopPropagation();
  pinSize();
  const el = dialog.value;
  const sx = e.clientX, sy = e.clientY, sw = el.offsetWidth, sh = el.offsetHeight;
  track(e.currentTarget, e, (ev) => {
    el.style.width = Math.max(360, Math.min(window.innerWidth - 40, sw + (ev.clientX - sx))) + 'px';
    el.style.height = Math.max(280, Math.min(window.innerHeight - 40, sh + (ev.clientY - sy))) + 'px';
  });
}
</script>

<template>
  <Teleport to="body">
    <div v-if="state.open" :key="state.key" class="pv-modal-backdrop" @click.self="store.close()">
      <div
        ref="dialog"
        class="pv-modal"
        :class="{ 'pv-modal--wide': state.wide }"
        role="dialog"
        aria-modal="true"
        :aria-label="state.title"
      >
        <div ref="header" class="pv-modal-header" :class="{ 'pv-modal-header--drag': desktop() }" @pointerdown="dragStart">
          <span class="pv-modal-title">{{ state.title }}</span>
          <button class="pv-modal-close" aria-label="Close" @click="store.close()">&#10005;</button>
        </div>
        <div v-if="state.component" ref="body" class="pv-modal-body" :class="{ 'pv-modal-body--flush': state.flush }">
          <component :is="state.component" v-bind="state.props" />
        </div>
        <!-- An HTML-string body (admin-menu.js's "unavailable" fallbacks): its caller builds
             it and escapes what it puts in it. -->
        <div v-else ref="body" class="pv-modal-body" :class="{ 'pv-modal-body--flush': state.flush }" v-html="state.html"></div>
        <div v-if="desktop()" class="pv-modal-resize" aria-hidden="true" @pointerdown="resizeStart"></div>
      </div>
    </div>
  </Teleport>
</template>
