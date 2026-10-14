// The viewer's one modal dialog (Help & tools windows, explainers, the ledger…): what it
// shows, and the open/close contract admin-menu.js has always offered:
//
//   open(title, body, onMount?, opts?)   body: an HTML string, or { component, props } for
//                                        a Vue component; onMount(bodyEl) runs once it's on
//                                        the page; opts: { wide, flush }
//   close()
//
// Opening while one is open replaces it. Focus goes back where it was on close.
import { markRaw, reactive } from 'vue';

export function createModalStore() {
  const state = reactive({
    open: false,
    key: 0,             // changes on every open, so the dialog renders afresh
    title: '',
    html: null,         // an HTML string body
    component: null,    // or a Vue component body
    props: {},
    wide: false,
    flush: false,
  });
  let onMount = null;
  let returnFocus = null;

  function open(title, body, mountFn, opts = {}) {
    if (!state.open) returnFocus = globalThis.document ? document.activeElement : null;
    const isComponent = body && typeof body === 'object' && body.component;
    Object.assign(state, {
      open: true,
      key: state.key + 1,
      title: String(title == null ? '' : title),
      html: isComponent ? null : String(body == null ? '' : body),
      component: isComponent ? markRaw(body.component) : null,
      props: isComponent ? body.props || {} : {},
      wide: !!opts.wide,
      flush: !!opts.flush,
    });
    onMount = typeof mountFn === 'function' ? mountFn : null;
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    state.html = null;
    state.component = null;
    onMount = null;
  }

  /** Called by ModalHost once the body is on the page: runs the opener's onMount once. */
  function mounted(bodyEl) {
    const fn = onMount;
    onMount = null;
    if (fn) fn(bodyEl);
  }

  /** Where focus goes when the dialog closes (taken once). */
  function takeReturnFocus() {
    const el = returnFocus;
    returnFocus = null;
    return el;
  }

  return { state, open, close, mounted, takeReturnFocus, isOpen: () => state.open };
}
