<!-- Street View: the selected parcel at street level, embedded (Maps Embed API), with a
     link to open it in Google Maps. It finds the viewpoint once it's open, so closing it
     early leaves nothing to pop up later. -->
<script setup>
import { onMounted, ref } from 'vue';
import { embedUrl, mapsUrl } from './streetview.js';

const props = defineProps({
  // null when no parcel (with a centroid) is selected: the window says how to pick one.
  parcel: { type: Object, default: null },
  apiKey: { type: String, default: '' },
  // Resolves { vp, lookAt, address } (streetview.js's resolveTarget).
  resolve: { type: Function, default: null },
  turf: { type: Object, default: null },
});

const view = ref(null);

onMounted(async () => {
  if (!props.parcel || !props.resolve) return;
  const { vp, lookAt, address } = await props.resolve();
  view.value = {
    embed: embedUrl(props.apiKey, vp, lookAt, props.turf),
    maps: mapsUrl(vp, lookAt, props.turf),
    label: address || props.parcel.site_address || 'this parcel',
  };
});
</script>

<template>
  <template v-if="!parcel">
    <p class="pv-modal-lead">Select a parcel first.</p>
    <p>Click a parcel on the map (or search for one), then open Street View to jump to street-level imagery at that location.</p>
  </template>
  <p v-else-if="!view" class="pv-modal-lead pv-sv-loading" role="status">Finding the nearest street view…</p>
  <template v-else>
    <div class="pv-sv-embed">
      <iframe
        class="pv-sv-iframe" :src="view.embed" loading="lazy" allowfullscreen
        referrerpolicy="no-referrer-when-downgrade" :title="`Street View of ${view.label}`"
      ></iframe>
    </div>
    <div class="pv-sv-foot">
      <span class="pv-sv-addr">{{ view.label }}</span>
      <a class="pv-sv-open" :href="view.maps" target="_blank" rel="noopener">Open in Google Maps <span aria-hidden="true">↗</span></a>
    </div>
  </template>
</template>
