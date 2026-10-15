<!-- Help: a quick reference, including keyboard navigation. -->
<script setup>
const TOPICS = [
  ['Find a parcel', 'Use the search box (or the search icon on mobile) to look up a parcel by parcel number, owner name, or address.'],
  ['Inspect a parcel', 'Click any parcel on the map to open the Parcel Info panel with assessment and geometry details.'],
  ['Overlays', 'Open Map Controls to toggle regulatory overlays (wetlands, soils, flood, zoning). Click the map with an overlay on to query it.'],
  ['Drawing & measure', 'Map Controls includes drawing and measurement tools for annotating the map.'],
  ['MapBuddy A.I.', 'Ask the assistant questions about the map, parcels, and overlays in plain language.'],
];
</script>

<template>
  <p class="pv-modal-lead">Quick reference for using the Parcel Viewer. Full documentation is coming soon.</p>
  <div v-for="[h, p] in TOPICS" :key="h" class="pv-help-item">
    <div class="pv-help-h">{{ h }}</div>
    <div class="pv-help-p">{{ p }}</div>
  </div>
  <div class="pv-help-item">
    <div class="pv-help-h">Keyboard navigation</div>
    <div class="pv-help-p">
      Everything works without a mouse.
      <ul class="pv-kbd-list">
        <li><strong>Tab</strong> / <strong>Shift+Tab</strong> — move forward / back between controls. A “Skip to map” link is the first stop.</li>
        <li><strong>Enter</strong> — activate a button or link, or open the highlighted search result.</li>
        <li><strong>Space</strong> — check or uncheck a layer (or any checkbox); also presses a button.</li>
        <li><strong>↑</strong> / <strong>↓</strong> arrows — move through search results; also adjust sliders and dropdowns.</li>
        <li><strong>Esc</strong> — close the search results, a panel, the tools menu, or a dialog.</li>
      </ul>
      <div class="pv-kbd-sub">Moving the map</div>
      Click the map once (or <strong>Tab</strong> to it), then:
      <ul class="pv-kbd-list">
        <li><strong>Arrow keys</strong> — pan (scroll) the map.</li>
        <li><strong>+</strong> / <strong>−</strong> — zoom in / out.</li>
        <li><strong>Shift</strong> + arrow keys — rotate and tilt the view.</li>
      </ul>
    </div>
  </div>
  <p class="pv-modal-note">Need more help? Use <strong>Feedback</strong> to reach the team.</p>
</template>
