// The parcel card's value formatters, by the format names in config.js. Each takes
// (value, ctx) as ISV_POPUP calls it (ctx.props is the whole parcel, ctx.geometry its
// shape) and returns display text, or null for "nothing on record".
//
// `env` brings what depends on the page: the county's code → name labels, the area-units
// preference, and how a point is written (the coordinate readout's format).

// One assessed-value history year -> a finite number or null. Blank or non-numeric roll
// values used to become NaN and draw <rect height="NaN"> bars (DIC-1873).
export function avYear(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export function createFormatters({ labels = {}, areaUnits = () => 'acres', formatPoint = () => null }) {
  const propClass = labels.propClass || {};
  const schoolDist = labels.schoolDist || {};
  return {
    site_address: (_v, ctx) => {
      const p = ctx.props || {};
      return [p.prop_street || p.PCOMBINED, p.prop_city].filter(Boolean).join(', ') || null;
    },
    area_units: (_v, ctx) => {
      const p = ctx.props || {};
      const v = p.gis_acres != null ? p.gis_acres : p.acres;
      if (v == null) return null;
      const ac = parseFloat(v);
      if (!ac) return null;
      const sqft = Math.round(ac * 43560).toLocaleString();
      if (areaUnits() === 'sqft') return sqft + ' sq ft';
      const acStr = ac.toFixed(2) + ' ac';
      return ac >= 1 ? acStr : `${acStr} (${sqft} sq ft)`;
    },
    center_point: (_v, ctx) => formatPoint(ctx.geometry),
    class_display: (_v, ctx) => {
      const p = ctx.props || {};
      const code = p.prop_class ? String(p.prop_class).trim() : null;
      const label = code && propClass[code];
      return code ? (label ? `${code} – ${label}` : code) : null;
    },
    school_display: (_v, ctx) => {
      const p = ctx.props || {};
      const code = p.school_dist ? String(p.school_dist).trim() : null;
      return (code && schoolDist[code]) || code || null;
    },
    source_provenance: (v) => (v && v !== 'migration' ? v : null),
    owner_mail: (_v, ctx) => {
      const p = ctx.props || {};
      return [p.owner_street || '',
        [p.owner_city || '', p.owner_state || ''].filter(Boolean).join(' '),
        p.owner_zip || ''].filter(Boolean).join(', ') || null;
    },
    true_market_value: (v) => {
      const n = v != null && v !== '' ? parseInt(v, 10) : null;
      return n != null && !Number.isNaN(n) ? '$' + (n * 2).toLocaleString() : null;
    },
    percent: (v) => {
      const n = v != null && v !== '' ? parseFloat(v) : null;
      return n != null && !Number.isNaN(n) ? n + '%' : null;
    },
    av_history: (_v, ctx) => {
      const p = ctx.props || {};
      return [p.assessed_value_yr0, p.assessed_value_yr1, p.assessed_value_yr2,
        p.assessed_value_yr3, p.assessed_value_yr4].map(avYear);
    },
    tax_description: (_v, ctx) => {
      const p = ctx.props || {};
      return p.ps_legal_description || p.legal_description || null;
    },
  };
}
