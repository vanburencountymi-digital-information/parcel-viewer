// A Vue module's side of the console's edit flow (DIC-2389): the store does the work
// (store.js); this keeps what the module shows about it, the flash message and the
// version history, as admin.js's modules did: Edit, Cancel and Publish start the page
// afresh (no message, history closed), and a message stays until the next one.
import { ref } from 'vue';

export function useEditFlow(store) {
  const flash = ref(null);     // { kind: 'ok' | 'err', message }
  const history = ref(null);   // null (closed), { loading }, { message } or { versions }

  const show = (res) => { flash.value = { kind: res.ok ? 'ok' : 'err', message: res.message }; };
  const fresh = () => { flash.value = null; history.value = null; };

  async function loadHistory() {
    history.value = { loading: true };
    const res = await store.versions();
    history.value = res.ok ? { versions: res.versions } : { message: res.message };
  }

  return {
    flash,
    history,
    /** A module's own message (e.g. "Pick a layer to add first."). */
    say(ok, message) { show({ ok, message }); },
    edit() { fresh(); store.edit(); },
    cancel() { fresh(); store.cancel(); },
    preview() { show(store.preview()); },
    async save() { show(await store.save()); },
    async publish() {
      const res = await store.publish();
      if (res.ok) fresh();
      show(res);
    },
    loadHistory,
    async restore(version) {
      const res = await store.rollback(version);
      const reloading = res.ok ? loadHistory() : null;   // the list now has the new version
      show(res);
      await reloading;
    },
  };
}
