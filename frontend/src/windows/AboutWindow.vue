<!-- About: the county, the app version (from the changelog), credits, and for a Protected
     county (ADR 0015) how the data may be used and where to get all of it. -->
<script setup>
import { computed, onMounted, ref } from 'vue';
import { loadChangelog } from './changelog.js';

const props = defineProps({
  county: { type: Object, default: () => ({}) },   // COUNTY: name, state
  access: { type: Object, default: () => ({}) },   // PV_ACCESS.countyAccess(): mode, termsUrl, dataUrl
  load: { type: Function, default: loadChangelog },
});

const countyName = computed(() => props.county.name || 'Van Buren County');
const place = computed(() => countyName.value + (props.county.state ? `, ${props.county.state}` : ''));
const version = ref('…');
onMounted(async () => {
  const d = await props.load();
  version.value = (d && d.version) || '0.x';
});

// Only http(s) links: the county config is data, and a javascript: URL would run.
const http = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const dataLinks = computed(() => [
  ['Terms of use', http(props.access.termsUrl)],
  ['Get the full dataset', http(props.access.dataUrl)],
].filter(([, url]) => url));
</script>

<template>
  <p class="pv-modal-lead"><strong>Parcel Viewer</strong> — {{ place }}</p>
  <div class="pv-about-grid">
    <div class="pv-about-k">Version</div><div id="pv-app-version" class="pv-about-v">{{ version }} (preview)</div>
    <div class="pv-about-k">Maintained by</div><div class="pv-about-v">DICE Labs</div>
    <div class="pv-about-k">Basemap</div><div class="pv-about-v">Esri Light/Dark Gray Canvas (Esri, HERE, Garmin, OpenStreetMap contributors)</div>
    <div class="pv-about-k">Parcel data</div><div class="pv-about-v">{{ countyName }} GIS</div>
    <template v-if="access.mode === 'protected'">
      <div class="pv-about-k">Data use</div>
      <div class="pv-about-v" data-testid="about-data-use">
        Owner and value details are limited to a daily amount per visitor.
        <template v-for="([text, url], i) in dataLinks" :key="url">{{ i ? ' · ' : ' ' }}<a :href="url" target="_blank" rel="noopener">{{ text }}</a></template>
      </div>
    </template>
  </div>
  <p class="pv-modal-note">This is a preview build. Data shown is for informational purposes only and is not a legal record of survey.</p>
</template>
