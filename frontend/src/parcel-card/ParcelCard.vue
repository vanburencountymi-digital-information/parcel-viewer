<!-- The parcel info panel's body: the parcel's sections, assessed values with their
     history chart, tax description and actions. Or, for a feature of another layer
     (pv-feature-info.js), that feature's details. Labels with data-tip show map.js's
     hover tooltip; the info (i) and tool buttons are wired by admin-menu.js's click
     delegation; the bookmark star is wired here. -->
<script setup>
const props = defineProps({ store: { type: Object, required: true } });
const state = props.store.state;
</script>

<template>
  <!-- Another layer's feature: the engine's own escaped markup (PV_FEATURE_INFO.renderHtml). -->
  <div v-if="state.featureHtml != null" class="pv-feature-info-body" v-html="state.featureHtml"></div>

  <template v-else-if="state.card">
    <div class="parcel-info-pin" data-testid="parcel-info-pin">{{ state.card.displayPin }}</div>
    <div class="parcel-info-zoning">{{ state.card.municipality }}</div>
    <!-- Past a Protected county's daily detail limit (ADR 0015) the owner and value fields
         arrive empty: say so, so "—" isn't read as "none on record". -->
    <p v-if="state.card.withheld" class="pv-withheld-note" role="note" data-testid="parcel-details-withheld">
      Owner and value details are withheld for the rest of today (daily detail limit).
      Everything else below is complete.
    </p>
    <hr class="parcel-info-divider">

    <template v-for="sec in state.card.sections" :key="sec.title">
      <div class="parcel-info-section-title" role="heading" aria-level="3">{{ sec.title }}</div>
      <div v-for="row in sec.rows" :key="row.label" class="parcel-info-row">
        <span class="parcel-info-label" :data-tip="row.tip">{{ row.label }}</span>
        <span class="parcel-info-value" :style="row.style">{{ row.value }}</span>
      </div>
      <hr class="parcel-info-divider">
    </template>

    <div class="parcel-info-section-title" role="heading" aria-level="3">
      Assessed Values<button
        class="pv-info-btn"
        data-info="assess"
        :data-pin="state.card.displayPin"
        data-tip="About property assessment"
        aria-label="About property assessment"
      ><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg></button>
    </div>
    <table class="parcel-info-table">
      <thead><tr><th></th><th>Current</th><th>Prior</th></tr></thead>
      <tbody>
        <tr v-for="row in state.card.assessed.rows" :key="row.label">
          <td :data-tip="row.tip">{{ row.label }}</td><td>{{ row.current }}</td><td>{{ row.prior }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="state.card.assessed.chart" style="margin-top:6px">
      <span class="parcel-info-label" :data-tip="state.card.assessed.historyTip">AV History</span>
      <svg
        :viewBox="`0 0 ${state.card.assessed.chart.width} ${state.card.assessed.chart.height}`"
        style="width:100%;height:auto;display:block;margin-top:3px"
        aria-label="AV history chart"
      >
        <defs>
          <linearGradient id="av-bar-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" :stop-color="state.colors.barTop" />
            <stop offset="100%" :stop-color="state.colors.barBottom" />
          </linearGradient>
        </defs>
        <template v-for="col in state.card.assessed.chart.columns" :key="col.year">
          <template v-if="col.bar">
            <rect :x="col.bar.x" :y="col.bar.y" :width="col.bar.w" :height="col.bar.h" fill="url(#av-bar-grad)" rx="2" />
            <text :x="col.cx" :y="col.bar.labelY" text-anchor="middle" font-size="9" :fill="state.colors.value">{{ col.bar.label }}</text>
          </template>
          <text :x="col.cx" :y="state.card.assessed.chart.height - 2" text-anchor="middle" font-size="9" :fill="state.colors.year">{{ col.year }}</text>
        </template>
      </svg>
    </div>
    <div v-else class="parcel-info-row">
      <span class="parcel-info-label" :data-tip="state.card.assessed.historyTip">AV History</span><span class="parcel-info-value">—</span>
    </div>
    <div class="parcel-info-row" style="margin-top:6px">
      <span class="parcel-info-label" :data-tip="state.card.assessed.preTip">PRE</span><span class="parcel-info-value">{{ state.card.assessed.pre }}</span>
    </div>
    <hr class="parcel-info-divider">

    <div class="parcel-info-section-title" role="heading" aria-level="3">
      Tax Description<button
        class="pv-info-btn"
        data-info="tax"
        :data-pin="state.card.displayPin"
        data-tip="About this tax description"
        aria-label="About this tax description"
      ><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg></button>
    </div>
    <div class="parcel-info-desc">{{ state.card.taxDescription }}</div>

    <div class="parcel-info-actions">
      <button
        type="button"
        class="pv-bm-toggle"
        :class="{ 'is-on': state.card.bookmarked }"
        :aria-pressed="String(state.card.bookmarked)"
        :title="state.card.bookmarked ? 'Remove bookmark' : 'Bookmark this parcel'"
        @click="store.toggleBookmark()"
      >
        <span class="pv-bm-star" aria-hidden="true">★</span>
        <span class="pv-bm-label">{{ state.card.bookmarked ? 'Bookmarked' : 'Bookmark' }}</span>
      </button>
      <button class="pv-ptool" data-ptool="streetview" :data-pin="state.card.pin">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="12" cy="10" r="3" /><path d="M12 2a8 8 0 0 0-8 8c0 5.4 8 12 8 12s8-6.6 8-12a8 8 0 0 0-8-8z" /></svg>
        <span>Street View</span>
      </button>
      <button class="pv-ptool" data-ptool="packet" :data-pin="state.card.pin">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><line x1="10" y1="9" x2="8" y2="9" /></svg>
        <span>Generate Parcel Packet</span>
      </button>
      <button class="pv-ptool" data-ptool="compare" :data-pin="state.card.pin">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><rect x="3" y="4" width="7" height="16" rx="1" /><rect x="14" y="4" width="7" height="16" rx="1" /></svg>
        <span>Compare Parcels</span>
      </button>
      <button class="pv-ptool" data-ptool="profile" :data-pin="state.card.pin">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /><line x1="12" y1="3" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="21" /></svg>
        <span>Neighborhood Profile</span>
      </button>
    </div>
  </template>
</template>
