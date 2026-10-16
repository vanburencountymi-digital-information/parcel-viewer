<!-- The assessment explainer's five-year assessed-value chart (explain.js's historyChart):
     the current year highlighted, the exact value above each bar. -->
<script setup>
defineProps({ chart: { type: Object, required: true } });
</script>

<template>
  <svg :viewBox="`0 0 ${chart.W} ${chart.H}`" style="width:100%;height:auto;display:block" role="img" aria-label="Five-year assessed value history, oldest to newest">
    <defs>
      <linearGradient id="xp-av-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" :stop-color="chart.colors.top" /><stop offset="100%" :stop-color="chart.colors.bottom" />
      </linearGradient>
    </defs>
    <template v-for="b in chart.bars" :key="b.year">
      <template v-if="b.bar">
        <rect :x="b.bar.x" :y="b.bar.y" :width="b.bar.w" :height="b.bar.h" rx="2" :fill="b.bar.current ? chart.colors.current : 'url(#xp-av-grad)'" />
        <text :x="b.cx" :y="b.labelY" text-anchor="middle" font-size="10" font-weight="600" :fill="chart.colors.value">{{ b.label }}</text>
      </template>
      <text :x="b.cx" :y="chart.yearY" text-anchor="middle" font-size="10" :fill="chart.colors.year">{{ b.year }}</text>
    </template>
  </svg>
</template>
