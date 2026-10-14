<!-- The parcel search box: a combobox input, its results listbox, a polite status for
     screen readers, and (on mobile, where the search opens as an overlay) a close button.
     Mounted inside #parcel-search, which stays the page's: capability gating hides it and
     the mobile overlay is a class on it. -->
<script setup>
import { nextTick, ref, watch } from 'vue';

const props = defineProps({ store: { type: Object, required: true } });
const emit = defineEmits(['close']);
const state = props.store.state;
const input = ref(null);
const list = ref(null);
defineExpose({ input });

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    // Esc with the list closed clears the search, and closes the mobile overlay.
    if (props.store.escape() === 'cleared') emit('close');
    return;
  }
  if (props.store.key(e.key)) e.preventDefault();
}

// Keep the highlighted option in view.
watch(() => state.active, async (i) => {
  if (i < 0) return;
  await nextTick();
  const el = list.value && list.value.querySelector(`#psr-opt-${i}`);
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
});
</script>

<template>
  <input
    id="parcel-search-input"
    ref="input"
    :value="state.query"
    class="parcel-search-input"
    type="text"
    placeholder="Search parcel number, owner, or address…"
    aria-label="Search parcels by parcel number, owner, or address"
    autocomplete="off"
    role="combobox"
    :aria-expanded="String(state.open && store.hasContent())"
    aria-controls="parcel-search-results"
    aria-autocomplete="list"
    aria-haspopup="listbox"
    :aria-activedescendant="state.active >= 0 ? `psr-opt-${state.active}` : null"
    @input="store.input($event.target.value)"
    @focus="store.reveal()"
    @keydown="onKeydown"
  >
  <div
    id="parcel-search-results"
    ref="list"
    class="parcel-search-results"
    role="listbox"
    aria-label="Parcel search results"
    :hidden="!state.open || !store.hasContent()"
  >
    <div v-if="state.error" class="parcel-search-no-results parcel-search-error" role="alert">{{ state.message }}</div>
    <div v-else-if="state.message" class="parcel-search-no-results" data-testid="parcel-search-no-results">{{ state.message }}</div>
    <div v-else class="parcel-search-page">
      <div
        v-for="(r, i) in state.results"
        :id="`psr-opt-${i}`"
        :key="`${r.id}-${i}`"
        class="parcel-search-result"
        :class="{ active: state.active === i }"
        role="option"
        :aria-selected="String(state.active === i)"
        @click="store.pick(i)"
        @mousemove="state.active !== i && (state.active = i)"
      >
        <div class="parcel-search-result-pin" data-testid="parcel-search-result-pin">{{ r.pin }}<template v-if="r.municipality"> · {{ r.municipality }}</template></div>
        <div class="parcel-search-result-owner">{{ r.owner_name || '—' }}</div>
        <div v-if="r.address" class="parcel-search-result-address">{{ r.address }}</div>
      </div>
    </div>
  </div>
  <div id="parcel-search-status" class="pv-sr-only" role="status" aria-live="polite" data-testid="parcel-search-status">{{ state.status }}</div>
  <!-- Close button: visible only in mobile overlay mode via CSS -->
  <button id="pv-search-close" class="pv-search-close" aria-label="Close search" @click.stop="$emit('close')">✕</button>
</template>
