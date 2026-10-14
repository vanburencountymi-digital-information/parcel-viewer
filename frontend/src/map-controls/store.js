// The Map Control Panel's state: which tab is active, whether the advanced tabs show, and
// which tabs a capability gates off. Collaborators are injected so Vitest can drive it.
import { computed, reactive } from 'vue';

// Layers is basic; the tools are advanced (hidden until the user opts in, DIC-402) unless the
// county lists its own advanced tabs (COUNTY.tools.advanced). A tab whose capability is off
// isn't shown at all (Phase 2 gating).
export const TABS = [
  { id: 'layers', title: 'Layers', header: 'Layers', cap: 'layers', advanced: false },
  { id: 'select', title: 'Selection Tools', header: 'Selection', cap: null, advanced: true },
  { id: 'draw', title: 'Drawing Tools', header: 'Drawing', cap: 'drawing', advanced: true },
  { id: 'measure', title: 'Measurement Tools', header: 'Measure', cap: 'measure', advanced: true },
];

/**
 * `capEnabled(cap)` gates tabs; `advancedTabs` (array or null) overrides which are advanced;
 * `storage` remembers the advanced choice; `onTabChange(prev, next)` runs on every switch
 * (the drawing and measure tools arm and disarm on it).
 */
export function createControlsStore({ capEnabled = () => true, advancedTabs = null, storage, onTabChange = () => {} }) {
  const tabs = TABS.map((t) => ({
    ...t,
    advanced: advancedTabs ? advancedTabs.includes(t.id) : t.advanced,
    gated: !!t.cap && !capEnabled(t.cap),
  }));
  const state = reactive({ tab: 'layers', advanced: false });
  const tabById = (id) => tabs.find((t) => t.id === id);
  const title = computed(() => (tabById(state.tab) || {}).header || state.tab);

  function setTab(id) {
    const prev = state.tab;
    state.tab = id;
    onTabChange(prev, id);
  }

  // A tab is shown unless its capability is off, or it's advanced and those are hidden.
  const shown = (t) => !t.gated && (!t.advanced || state.advanced);

  /** Shows or hides the advanced tabs; hiding the active one moves to the first tab shown. */
  function setAdvanced(on) {
    state.advanced = !!on;
    storage.set(on);
    if (!shown(tabById(state.tab))) {
      const first = tabs.find(shown);
      if (first) setTab(first.id);
    }
  }

  // Never start on a tab that isn't shown (e.g. a gated Layers).
  setAdvanced(storage.get());

  return { state, tabs, title, setTab, setAdvanced, getTab: () => state.tab };
}
