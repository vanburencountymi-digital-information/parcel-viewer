// PostGIS layer discovery (DIC-502; moved from admin.js in DIC-2389): the spatial layers
// the tile server can serve (geo.<name>_tiles), which staff can add to the config as
// vector overlays without a developer. Admin-only since DIC-1872: it scans every geo
// table, so it needs the staff token.

export const NEEDS_SIGN_IN = 'Layer discovery needs a staff sign-in.';

/**
 * Resolves { layers } or { error }, never rejects. error is 'sign-in' (no token, or it
 * was refused), 'staff' (not staff, or no access to this county), or why it failed
 * (e.g. "HTTP 500").
 */
export async function loadDiscovered({ fetch, apiBase, auth }) {
  if (!auth.has()) return { error: 'sign-in' };
  try {
    const r = await fetch(apiBase() + '/admin/discover/layers', { cache: 'no-cache', headers: auth.headers() });
    if (r.status === 401) { auth.noteRefused(401); return { error: 'sign-in' }; }
    if (r.status === 403) return { error: 'staff' };
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const res = await r.json();
    return { layers: (res && res.layers) || [] };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

/** The message under the pulldown when discovery failed. */
export function discoveryError(error) {
  if (error === 'sign-in') return NEEDS_SIGN_IN;
  if (error === 'staff') return 'Layer discovery isn’t allowed for this account (not staff, or no access to this county).';
  return 'Couldn’t reach the tile server / DB (' + error + ').';
}

/** "drain_lines" → "Drain Lines"; PLSS stays upper case. */
export function titleize(id) {
  return String(id || '').split(/[_\s]+/).map((w) => {
    if (/^plss$/i.test(w)) return 'PLSS';
    return w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  }).join(' ');
}

/** The discovered layers not yet added: not registered on the server, nor in `cfg`. */
export function availableLayers(layers, cfg) {
  const added = new Set(((cfg.layers || {}).overlays || [])
    .filter((o) => String(o.type || '').toLowerCase() === 'vector' && o.source)
    .map((o) => o.source));
  return layers.filter((d) => !d.registered && !added.has(d.source));
}

/** The pulldown's text for a discovered layer: "Drain Lines — line, 1,234 features". */
export function optionText(d) {
  const bits = [d.geomType || '—'];
  if (d.rowCount != null) bits.push(Number(d.rowCount).toLocaleString() + ' features');
  return titleize(d.id) + ' — ' + bits.join(', ');
}

// A distinct default paint per geometry kind (editable later in Styling).
const PALETTE = {
  polygon: { light: { fill: '#2F6B4F', stroke: '#1f4d39' }, dark: { fill: '#4E9A6B', stroke: '#6db38a' } },
  line: { light: { fill: '#1F5E80', stroke: '#1F5E80' }, dark: { fill: '#2E76A6', stroke: '#7fb6d8' } },
  point: { light: { fill: '#B58D4A', stroke: '#8B6535' }, dark: { fill: '#d4a862', stroke: '#b8923f' } },
};
export const defaultPaint = (geomType) => structuredClone(PALETTE[geomType] || PALETTE.polygon);

/** The config overlay for a discovered layer. */
export function overlayFor(d) {
  return {
    id: d.id, label: titleize(d.id), type: 'vector',
    source: d.source, sourceLayer: d.sourceLayer,
    geomType: d.geomType || 'polygon', minZoom: 12, default: false,
    dbSource: d.dbSource, fields: d.fields || [],
  };
}
