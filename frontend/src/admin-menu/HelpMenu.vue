<!-- The Help & tools menu: a topbar button and its dropdown. Each item opens its window
     through window.PV_TOOLS (admin-menu.js), as Map Buddy and hints do. Esc or a click
     outside closes the dropdown. -->
<script setup>
import { onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({
  items: { type: Array, required: true },   // [{ tool, label, icon } | { sep: true }]
  openTool: { type: Function, required: true },
});
const open = ref(false);
const button = ref(null);
const menu = ref(null);

function onDocClick(e) {
  if (!menu.value.contains(e.target) && !button.value.contains(e.target)) open.value = false;
}
function onKey(e) {
  if (e.key === 'Escape') { open.value = false; button.value.focus(); }
}
watch(open, (on) => {
  const add = on ? 'addEventListener' : 'removeEventListener';
  document[add]('click', onDocClick, true);
  document[add]('keydown', onKey);
});
onBeforeUnmount(() => { open.value = false; });

function choose(tool) {
  open.value = false;
  props.openTool(tool);
}
</script>

<template>
  <button
    id="pv-admin-btn"
    ref="button"
    class="pv-admin-btn"
    title="Help &amp; tools"
    aria-label="Help and tools"
    aria-haspopup="true"
    :aria-expanded="String(open)"
    @click.stop="open = !open"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
  </button>
  <div id="pv-admin-menu" ref="menu" class="pv-admin-menu" role="menu" aria-label="Help and tools" :hidden="!open">
    <template v-for="(item, i) in items" :key="item.tool || `sep-${i}`">
      <div v-if="item.sep" class="pv-admin-sep"></div>
      <button v-else class="pv-admin-item" role="menuitem" :data-tool="item.tool" @click="choose(item.tool)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" v-html="item.icon"></svg>
        <span>{{ item.label }}</span>
      </button>
    </template>
  </div>
</template>
