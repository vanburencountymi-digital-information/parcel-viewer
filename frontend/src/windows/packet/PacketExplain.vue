<!-- A Packet section's "What this means" panel: the plain-language explanation (the slot),
     then a Q&A scoped to the section: suggested questions and an ask box. Answers are
     canned (packet-data.js) and arrive after a short "thinking" beat. -->
<script setup>
import { onBeforeUnmount, ref } from 'vue';
import { PACKET_QA, answerFor } from './packet-data.js';

const props = defineProps({
  qaKey: { type: String, required: true },
  // How long the answer "thinks" (ms).
  delay: { type: Number, default: 550 },
});

const cfg = PACKET_QA[props.qaKey] || { ph: 'Ask a question…', qa: [] };
const thread = ref(null);
const turns = ref([]);   // { q, a } — a is null while thinking
const question = ref('');
const timers = new Set();

function ask(q) {
  const text = String(q || '').trim();
  if (!text) return;
  const turn = { q: text, a: null };
  turns.value.push(turn);
  const t = setTimeout(() => {
    timers.delete(t);
    turns.value[turns.value.indexOf(turn)].a = answerFor(props.qaKey, text);
    if (thread.value && thread.value.scrollIntoView) thread.value.scrollIntoView({ block: 'nearest' });
  }, props.delay);
  timers.add(t);
}

function onSubmit() {
  const q = question.value;
  question.value = '';
  ask(q);
}

onBeforeUnmount(() => timers.forEach(clearTimeout));
</script>

<template>
  <div class="pp-explain" :data-qa="qaKey">
    <div class="pp-explain-h"><span aria-hidden="true">✨</span> What this means</div>
    <p><slot /></p>
    <div ref="thread" class="pp-qa-thread" aria-live="polite">
      <template v-for="(turn, i) in turns" :key="i">
        <div class="pp-qa-row pp-qa-q">{{ turn.q }}</div>
        <div class="pp-qa-row pp-qa-a">
          <span v-if="turn.a === null" class="pp-qa-dots" aria-label="Thinking">•••</span>
          <template v-else>{{ turn.a }}</template>
        </div>
      </template>
    </div>
    <div v-if="cfg.qa.length" class="pp-qa-chips">
      <button v-for="x in cfg.qa" :key="x.q" type="button" class="pp-qa-chip" @click="ask(x.q)">{{ x.q }}</button>
    </div>
    <form class="pp-qa-form" @submit.prevent="onSubmit">
      <input
        v-model="question" type="text" class="pp-qa-input" autocomplete="off"
        aria-label="Ask a question about this section" :placeholder="cfg.ph"
      >
      <button type="submit" class="pp-qa-send">Ask</button>
    </form>
  </div>
</template>
