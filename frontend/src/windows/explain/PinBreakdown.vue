<!-- The parcel number broken into its parts (the engine's parsePinSegments, from the
     county's parcelNumber config): the PIN with each part tinted, then a legend of what
     each part means. Parts past the configured segments are kept and marked "unmapped". -->
<script setup>
import { PIN_COLORS } from './explain.js';

defineProps({ breakdown: { type: Object, required: true } });
const color = (i) => PIN_COLORS[i % PIN_COLORS.length];
</script>

<template>
  <div class="pv-pin-break">
    <p v-if="breakdown.intro" class="pv-pin-intro">{{ breakdown.intro }}</p>
    <div class="pv-pin-line" aria-hidden="true">
      <template v-for="(p, i) in breakdown.parts" :key="i">
        <span v-if="i > 0" class="pv-pin-sep">{{ breakdown.separator }}</span>
        <span class="pv-pin-seg" :style="{ color: color(i), borderColor: color(i) }">{{ p.value }}</span>
      </template>
    </div>
    <ul class="pv-pin-list">
      <li v-for="(p, i) in breakdown.parts" :key="i" class="pv-pin-row">
        <span class="pv-pin-chip" :style="{ background: color(i) }">{{ p.value }}</span>
        <div class="pv-pin-meaning">
          <div class="pv-pin-name">{{ p.name }}<template v-if="p.extra"> <span class="pv-pin-extra">unmapped</span></template></div>
          <div v-if="p.description" class="pv-pin-desc">{{ p.description }}</div>
        </div>
      </li>
    </ul>
  </div>
</template>
