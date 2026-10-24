<!-- The Admin Console's shell (DIC-467; a Vue island since DIC-2389): the sidebar with the
     module nav and the staff sign-in, the top bar, and the content area. Mounted inside
     #ac-app, with the same markup admin/index.html had.

     A module is a Vue component, or (until it moves) drawn by admin.js with render(host).
     Those draw into their own <div> inside <main>, which Vue gives no children, so Vue
     never touches what they drew. -->
<script setup>
import { computed, onMounted, ref, shallowRef } from 'vue';
import StaffSignIn from './StaffSignIn.vue';

const props = defineProps({
  store: { type: Object, required: true },
  auth: { type: Object, required: true },
  modules: { type: Array, required: true },   // [{ id, label, icon, component | render(host) }]
  win: { type: Object, default: () => globalThis },
});
const state = props.store.state;
const content = ref(null);       // <main>
const legacyHost = ref(null);    // where admin.js's modules draw
const view = shallowRef(null);   // the open Vue module's component, if it is one

const countyName = computed(() => (state.config && state.config.name) || 'Van Buren County');
const statusText = computed(() => (state.source === 'api' ? 'Live config · read-only' : 'Read-only preview'));

const moduleFor = (id) => props.modules.find((m) => m.id === id) || props.modules[0];

/** Opens a module (or redraws the open one) and keeps it in the address. */
function show(id) {
  const mod = moduleFor(id);
  if (!mod || !content.value) return;   // no modules, or unmounted before /config answered
  props.store.show(mod.id);
  view.value = mod.component || null;
  // A legacy module redraws itself; a Vue one follows the store. Clear what a legacy one
  // drew, so its ids (#ac-flash, #ac-history) aren't on the page twice.
  if (mod.render) mod.render(legacyHost.value);
  else legacyHost.value.innerHTML = '';
  content.value.focus();
  const { location, history } = props.win;
  if (location.hash !== '#' + mod.id) history.replaceState(null, '', '#' + mod.id);
}
const redraw = () => show(state.active);

onMounted(() => {
  const initial = (props.win.location.hash || '').replace('#', '');
  show(props.modules.some((m) => m.id === initial) ? initial : 'county');
  // Signing in or out redraws the open module (its buttons and messages depend on it).
  props.auth.onChange(redraw);
  // Then the authoritative config from the runtime API.
  props.store.loadConfig().then(redraw);
});
</script>

<template>
  <aside class="ac-side" role="navigation" aria-label="Admin sections">
    <div class="ac-brand">
      <span class="ac-brand-mark">◆</span>
      <span class="ac-brand-text">Parcel Viewer<small>Admin Console</small></span>
    </div>
    <nav id="ac-nav" class="ac-nav">
      <button
        v-for="m in modules"
        :key="m.id"
        type="button"
        class="ac-nav-item"
        :class="{ 'is-active': m.id === state.active }"
        :data-mod="m.id"
        :aria-current="m.id === state.active ? 'page' : null"
        @click="show(m.id)"
      >
        <span class="ac-nav-ico">{{ m.icon }}</span><span>{{ m.label }}</span>
      </button>
    </nav>
    <div id="ac-auth" class="ac-side-foot ac-auth" data-testid="ac-auth">
      <StaffSignIn :store="auth" />
    </div>
  </aside>

  <div class="ac-main">
    <header class="ac-topbar">
      <div class="ac-county">
        <label for="ac-county-select" class="ac-county-label">County</label>
        <select id="ac-county-select" class="ac-county-select" aria-label="Active county">
          <option>{{ countyName }}</option>
        </select>
      </div>
      <div class="ac-top-actions">
        <span id="ac-status" class="ac-pill" role="status" aria-label="Config status">{{ statusText }}</span>
      </div>
    </header>
    <main id="ac-content" ref="content" class="ac-content" tabindex="-1">
      <component :is="view" v-if="view" :store="store" />
      <div v-show="!view" ref="legacyHost"></div>
    </main>
  </div>
</template>
