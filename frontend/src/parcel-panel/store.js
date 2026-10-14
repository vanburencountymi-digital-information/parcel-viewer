// The parcel info panel's state: whether it shows, its title, and where a multi-parcel
// selection is (n of N). map.js decides when it opens, collapses (keeping the selection,
// leaving the reopen tab) or hides; the panel's own controls ask map.js (`map`, its
// PS_PARCEL_PANEL) to cycle, fly to the parcel or clear the selection.
import { reactive } from 'vue';

export function createPanelStore({ map }) {
  const state = reactive({
    view: 'hidden',    // 'hidden' | 'open' | 'collapsed' (the reopen tab shows instead)
    title: 'Parcel',
    index: 0,          // the parcel on show, in a multi-parcel selection
    count: 0,
  });

  return {
    state,
    isOpen: () => state.view === 'open',
    isCollapsed: () => state.view === 'collapsed',
    /** Shows the panel, unless the user collapsed it (a new parcel doesn't undo that). */
    open() { if (state.view !== 'collapsed') state.view = 'open'; },
    collapse() { state.view = 'collapsed'; },
    expand() { state.view = 'open'; },
    hide() { state.view = 'hidden'; },
    setTitle(title) { state.title = title; },
    setNav(index, count) { state.index = index; state.count = count; },
    // The panel's controls.
    cycle: (direction) => map.cycle(direction),
    flyTo: () => map.flyTo(),
    close: () => map.close(),
    reopen: () => map.reopen(),
  };
}
