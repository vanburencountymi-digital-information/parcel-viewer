<!-- Share: a link to the selected parcel and the current map view, with Copy. -->
<script setup>
import { onBeforeUnmount, ref } from 'vue';

const props = defineProps({
  url: { type: String, required: true },
  // Copies text; resolves when done (the clipboard API, else the selection and execCommand).
  copy: { type: Function, default: null },
});
const input = ref(null);
const copied = ref(false);
let timer = null;

async function legacyCopy() {
  try { document.execCommand('copy'); } catch { /* nothing more to try */ }
}

async function onCopy() {
  input.value.select();
  try {
    if (props.copy) await props.copy(props.url);
    else if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(props.url);
    else await legacyCopy();
  } catch {
    await legacyCopy();
  }
  copied.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => { copied.value = false; }, 1500);
}
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <p class="pv-modal-lead">Share a link to this view.</p>
  <div class="pv-copy-row">
    <input id="pv-share-url" ref="input" class="pv-input" type="text" readonly aria-label="Share link" :value="url">
    <button id="pv-share-copy" type="button" class="pv-btn-primary" @click="onCopy">{{ copied ? 'Copied!' : 'Copy' }}</button>
  </div>
  <p class="pv-modal-note">
    <span class="pv-badge">Preview</span>
    Links that capture the selected parcel, zoom, and active layers are planned. For now this copies the current page URL.
  </p>
</template>
