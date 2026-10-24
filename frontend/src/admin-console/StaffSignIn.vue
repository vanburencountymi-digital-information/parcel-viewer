<!-- The sidebar's staff sign-in (DIC-2151; was HTML built by admin.js): the form while
     signed out, who is signed in and a Sign out button while signed in. Mounted inside
     #ac-auth, which stays the page's. -->
<script setup>
import { ref } from 'vue';

const props = defineProps({ store: { type: Object, required: true } });
const state = props.store.state;
const username = ref('');
const password = ref('');

async function submit() {
  const ok = await props.store.signIn(username.value.trim(), password.value);
  // Refused: try again with a fresh password (the username stays). Signed in: the form
  // is gone, and comes back empty after signing out.
  password.value = '';
  if (ok) username.value = '';
}
</script>

<template>
  <template v-if="state.user">
    <p class="ac-auth-who">Signed in as <strong>{{ state.user.username || 'staff' }}</strong></p>
    <button id="ac-signout" type="button" class="ac-btn ac-btn-sm" @click="store.signOut()">Sign out</button>
  </template>
  <form v-else id="ac-signin" class="ac-signin" novalidate @submit.prevent="submit">
    <p class="ac-auth-title">Staff sign-in</p>
    <label class="ac-auth-label" for="ac-signin-user">Username</label>
    <input id="ac-signin-user" v-model="username" class="ac-input ac-auth-input" name="username" autocomplete="username" required>
    <label class="ac-auth-label" for="ac-signin-pass">Password</label>
    <input id="ac-signin-pass" v-model="password" class="ac-input ac-auth-input" name="password" type="password" autocomplete="current-password" required>
    <button type="submit" class="ac-btn ac-btn-primary ac-btn-sm" :disabled="state.busy">Sign in</button>
    <p id="ac-signin-msg" class="ac-auth-msg" role="status" aria-live="polite">{{ state.message }}</p>
  </form>
</template>
