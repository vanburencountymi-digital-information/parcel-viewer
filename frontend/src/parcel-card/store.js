// The parcel card's state: the card for the parcel on show (card.js), or another layer's
// feature, plus the chart colours for the current theme. map.js calls show() for each
// parcel it puts in the panel (and again when the theme, area units or coordinate format
// change); pv-feature-info.js calls showFeature().
//
// The page is injected (`env`), so Vitest drives it without one.
import { reactive } from 'vue';
import { buildCard } from './card.js';

// WCAG 2.1 AA (DIC-376): both label fills clear 4.5:1 in each theme.
const CHART_COLORS = {
  light: { barTop: '#CBAB7A', barBottom: '#B58D4A', value: '#6D5C52', year: '#4b5563' },
  dark: { barTop: '#6b5a38', barBottom: '#4a3e26', value: '#b09a7a', year: '#b9bdc4' },
};

export function createParcelCardStore(env) {
  const state = reactive({
    card: null,          // buildCard()'s result
    featureHtml: null,   // another layer's feature, as the engine rendered it
    colors: CHART_COLORS.light,
  });

  function show(pin, props, geometry) {
    state.featureHtml = null;
    state.colors = env.isDark() ? CHART_COLORS.dark : CHART_COLORS.light;
    state.card = buildCard({ pin, props, geometry }, env.cardDeps());
  }

  function showFeature(html) {
    state.card = null;
    state.featureHtml = html;
  }

  /** The star: bookmark the parcel on show, or remove its bookmark. */
  function toggleBookmark() {
    if (!state.card) return;
    const pc = env.selectedParcel();
    if (!pc) return;
    state.card.bookmarked = !!env.toggleBookmark(pc);
  }

  return { state, show, showFeature, toggleBookmark };
}
