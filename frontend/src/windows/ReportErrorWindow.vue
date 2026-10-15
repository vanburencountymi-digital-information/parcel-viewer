<!-- Report a data error: a short form POSTed to the API's /report-error, then a thank-you.
     The API emails it to staff; it answers 429 when one visitor sends too many. -->
<script setup>
import { reactive, ref } from 'vue';
import FormField from './FormField.vue';

const props = defineProps({
  // The selected parcel's number, filled in for the visitor.
  pin: { type: String, default: '' },
  // Sends the report; resolves on success, rejects (with .status for HTTP errors) otherwise.
  send: { type: Function, required: true },
  close: { type: Function, required: true },
});

const form = ref(null);
const data = reactive({ pin: props.pin, details: '', email: '' });
const sending = ref(false);
const error = ref('');
const sent = ref(false);

async function onSubmit() {
  if (!form.value.checkValidity()) { form.value.reportValidity(); return; }
  sending.value = true;
  try {
    await props.send({ ...data });
    sent.value = true;
  } catch (err) {
    error.value = err && err.status === 429
      ? 'You’ve sent several reports recently. Please wait a while and try again.'
      : 'Sorry — couldn’t send your report just now. Please try again.';
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div v-if="sent" class="pv-form-success">
    <div class="pv-form-success-icon">&#10003;</div>
    <div class="pv-form-success-title">Report received!</div>
    <p class="pv-form-success-msg">Thanks for helping keep the data accurate — we’ll review it.</p>
    <button type="button" class="pv-btn-primary" data-close @click="close">Close</button>
  </div>
  <template v-else>
    <p class="pv-modal-lead">Spotted incorrect parcel data? Tell us what looks wrong.</p>
    <form ref="form" class="pv-form" novalidate @submit.prevent="onSubmit">
      <FormField label="Parcel number" :note="pin ? '' : '(if known)'">
        <input v-model="data.pin" type="text" name="pin" class="pv-input" placeholder="00-00-000-000-00">
      </FormField>
      <FormField label="What’s incorrect?">
        <textarea
          v-model="data.details" name="details" class="pv-input" rows="4" required
          placeholder="Describe the error — wrong owner, boundary, address, zoning…"
        ></textarea>
      </FormField>
      <FormField label="Email" note="(optional, for follow-up)">
        <input v-model="data.email" type="email" name="email" class="pv-input" placeholder="you@example.com">
      </FormField>
      <p v-if="error" class="pv-form-error" role="alert">{{ error }}</p>
      <div class="pv-form-actions">
        <button type="button" class="pv-btn-ghost" data-close @click="close">Cancel</button>
        <button type="submit" class="pv-btn-primary" :disabled="sending">{{ sending ? 'Sending…' : 'Send report' }}</button>
      </div>
    </form>
  </template>
</template>
