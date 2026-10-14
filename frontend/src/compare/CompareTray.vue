<!-- The Compare tray: the parcels picked so far, as removable chips, and the button that
     opens the table once there are enough. Hidden while the set is empty. -->
<script setup>
import { computed } from 'vue';
import { MIN, itemKey } from './store.js';

const props = defineProps({ store: { type: Object, required: true } });
const state = props.store.state;
const ready = computed(() => state.set.length >= MIN);
</script>

<template>
  <div id="pv-compare-tray" class="pv-compare-tray" data-testid="pv-compare-tray" :hidden="!state.set.length">
    <span class="pv-compare-tray-label">Compare</span>
    <span class="pv-compare-chips">
      <span
        v-for="p in state.set"
        :key="itemKey(p)"
        class="pv-compare-chip"
        data-testid="pv-compare-chip"
      >{{ p.pin || p.id }}<button
          type="button"
          class="pv-compare-chip-x"
          aria-label="Remove"
          @click="store.remove(itemKey(p))"
        >×</button></span>
    </span>
    <button type="button" class="pv-compare-go" :disabled="!ready" @click="store.show()">
      Compare{{ ready ? ` (${state.set.length})` : '' }}
    </button>
    <button type="button" class="pv-compare-clear" aria-label="Clear comparison" @click="store.clear()">Clear</button>
  </div>
</template>
