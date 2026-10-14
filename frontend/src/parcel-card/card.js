// The parcel card's model: what ParcelCard.vue shows for one parcel. Pure (the engine's
// popup renderer and the page's preferences are passed in), so Vitest checks it directly.
// Values are plain text: Vue escapes them, so tax-roll text can't become markup (DIC-1852).

const val = (r) => (r && r.value != null && r.value !== '' ? r.value : null);

/** The PIN the card shows: the parcel number when there is one, else the selection key. */
export function displayPin(selectionKey, props) {
  const p = props || {};
  return p.parcel_no || p.pin || p.PIN || selectionKey || p.id || '';
}

/**
 * The AV history chart for `history` (newest first, as the roll stores it; null for a
 * missing year), ending at `rollYear`: bars oldest to newest, scaled to the largest value.
 * Null when no year has a value.
 */
export function avHistoryChart(history, rollYear) {
  const vals = history.slice().reverse();
  const valid = vals.filter((v) => v != null);
  if (!valid.length) return null;
  const W = 240, H = 74, labelH = 13, valueH = 11, barAreaH = H - labelH - valueH;
  const colW = W / vals.length, barW = colW * 0.55;
  const max = Math.max(...valid);
  return {
    width: W,
    height: H,
    columns: vals.map((v, i) => {
      const cx = colW * i + colW / 2;
      const year = rollYear - (vals.length - 1 - i);
      if (v == null) return { cx, year, bar: null };
      const h = Math.max(3, Math.round((max > 0 ? v / max : 0) * barAreaH));   // all-zero history: no 0/0
      const y = valueH + barAreaH - h;
      return { cx, year, bar: { x: (cx - barW / 2).toFixed(1), y: y.toFixed(1), w: barW.toFixed(1), h: h.toFixed(1), label: '$' + Math.round(v / 1000) + 'k', labelY: (y - 2).toFixed(1) } };
    }),
  };
}

/**
 * The card for one parcel. `popup` is ISV_POPUP; `source` the popup config (config.js);
 * `formatters` from formatters.js; `rollYear(props)` the year the AV history ends at;
 * `isWithheld(props)` whether a Protected county withheld its details (ADR 0015);
 * `isBookmarked(id)` the star's state.
 */
export function buildCard({ pin, props, geometry }, { popup, source, formatters, labels, rollYear, isWithheld, isBookmarked }) {
  const p = props || {};
  const sections = popup.renderSections(source, { properties: p, geometry }, { labels, formatters });
  const rowsOf = (title) => ((sections.find((s) => s.section === title) || {}).rows || []);
  const byLabel = (title) => Object.fromEntries(rowsOf(title).map((r) => [r.label, r]));

  // Plain sections: one row per field, "—" when empty, unless the field is skipEmpty.
  const plain = (title) => ({
    title,
    rows: rowsOf(title)
      .filter((r) => !(r.skipEmpty && val(r) == null))
      .map((r) => ({ label: r.label, tip: r.tip || null, style: r.style || null, value: val(r) ?? '—' })),
  });

  const av = byLabel('Assessed Values');
  const cell = (label) => val(av[label]) ?? '—';
  const tip = (label) => (av[label] && av[label].tip) || null;
  const history = Array.isArray(val(av['AV History'])) ? av['AV History'].value : [];

  return {
    pin,
    displayPin: displayPin(pin, p),
    municipality: p.municipality || '—',
    withheld: !!isWithheld(p),
    sections: [plain('Parcel'), plain('Owner')],
    assessed: {
      rows: [['AV', 'AV Prior'], ['TV', 'TV Prior'], ['TMV', 'TMV Prior']]
        .map(([cur, prior]) => ({ label: cur, tip: tip(cur), current: cell(cur), prior: cell(prior) })),
      historyTip: tip('AV History'),
      chart: avHistoryChart(history, rollYear(p)),
      pre: cell('PRE'),
      preTip: tip('PRE'),
    },
    taxDescription: val(rowsOf('Tax Description')[0]) ?? '—',
    bookmarked: p.id != null && !!isBookmarked(p.id),
  };
}
