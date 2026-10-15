<!-- Bookmarks: the parcels saved on this device (PV_BOOKMARKS, admin-menu.js), to open or
     remove, and a button to bookmark the parcel on show. -->
<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
  bookmarks: { type: Object, required: true },   // PV_BOOKMARKS: list, has, add, remove
  parcel: { type: Object, default: null },        // PS_STATE.parcel: { id, pin, … }
  openParcel: { type: Function, required: true }, // (id) → select it on the map
  close: { type: Function, required: true },
});

const version = ref(0);                           // bumped on every change, to re-read the list
const list = computed(() => { void version.value; return props.bookmarks.list(); });
const current = computed(() => (props.parcel && props.parcel.id != null ? props.parcel : null));
const currentSaved = computed(() => { void version.value; return !!current.value && props.bookmarks.has(current.value.id); });
const sub = (b) => [b.owner, b.address || b.muni].filter(Boolean).join(' · ');

function add() { props.bookmarks.add(current.value); version.value++; }
function remove(id) { props.bookmarks.remove(id); version.value++; }
function open(id) { props.close(); props.openParcel(id); }
</script>

<template>
  <p class="pv-modal-lead">Saved parcels, stored on this device.</p>
  <p v-if="!list.length" class="pv-empty">
    No bookmarks yet. Open a parcel and use the <strong>★ Bookmark</strong> button on its panel — saved parcels appear here.
  </p>
  <ul v-else class="pv-bm-list">
    <li v-for="b in list" :key="b.id" class="pv-bm-item">
      <button type="button" class="pv-bm-open" :data-bm-open="b.id" @click="open(b.id)">
        <span class="pv-bm-pin">{{ b.pin || String(b.id) }}</span>
        <span v-if="sub(b)" class="pv-bm-sub">{{ sub(b) }}</span>
      </button>
      <button
        type="button"
        class="pv-bm-del"
        :data-bm-del="b.id"
        :aria-label="`Remove bookmark ${b.pin || String(b.id)}`"
        title="Remove"
        @click="remove(b.id)"
      >✕</button>
    </li>
  </ul>
  <template v-if="current">
    <p v-if="currentSaved" class="pv-modal-note">Current parcel ({{ current.pin }}) is bookmarked.</p>
    <div v-else class="pv-form-actions">
      <button id="pv-bm-add" type="button" class="pv-btn-primary" @click="add">★ Bookmark current parcel ({{ current.pin }})</button>
    </div>
  </template>
</template>
