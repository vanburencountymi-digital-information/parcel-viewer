<!-- What's New: the changelog's releases, newest first. -->
<script setup>
import { onMounted, ref } from 'vue';
import { loadChangelog } from './changelog.js';

const props = defineProps({ load: { type: Function, default: loadChangelog } });
const state = ref('loading');   // 'loading' | 'ready' | 'unavailable'
const releases = ref([]);

onMounted(async () => {
  const d = await props.load();
  releases.value = (d && d.releases) || [];
  state.value = releases.value.length ? 'ready' : 'unavailable';
});
</script>

<template>
  <p class="pv-modal-lead">Recent updates and new functionality.</p>
  <div id="pv-changelog" class="pv-changelog">
    <template v-if="state === 'loading'">Loading…</template>
    <p v-else-if="state === 'unavailable'" class="pv-empty">Release notes are unavailable right now.</p>
    <div v-for="rel in releases" v-else :key="rel.version" class="pv-change">
      <div class="pv-change-date">v{{ rel.version }}<template v-if="rel.date"> · {{ rel.date }}</template></div>
      <ul class="pv-change-list">
        <li v-for="(item, i) in rel.items || []" :key="i">{{ item }}</li>
      </ul>
    </div>
  </div>
</template>
