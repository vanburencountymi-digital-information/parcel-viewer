// Editing a config draft by path (DIC-464/466; moved from admin.js in DIC-2389). The
// editors name each field by its dotted config path ("map.zoom",
// "styling.layers.parcels.choropleth.stops.2.color").

export function clone(o) { return JSON.parse(JSON.stringify(o || {})); }

// Config paths come from the manifest being edited; refuse the keys that reach
// JavaScript's shared object prototype (CodeQL js/prototype-pollution-utility, DIC-1880).
// A list, not an object: in a literal, '__proto__': … sets the prototype rather than
// adding a key.
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
function safePath(path) {
  const parts = String(path).split('.');
  for (const p of parts) {
    if (UNSAFE_KEYS.includes(p)) throw new Error('Unsafe config path: ' + path);
  }
  return parts;
}

export function setPath(obj, path, value) {
  const parts = safePath(path);
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

export function getPath(obj, path) {
  let o = obj;
  for (const p of safePath(path)) { if (o == null) return undefined; o = o[p]; }
  return o;
}

// Templates for "Add row" on editable arrays, keyed by their config path.
const ADD_TEMPLATES = {
  'layers.overlays': { id: '', label: 'New PostGIS layer', type: 'vector', source: '', minZoom: 0, default: false },
  'layers.dataSources': { id: '', label: '', source: '' },
  'choropleth.categories': { value: '', label: '', color: '#888888' },
  'choropleth.stops': { min: 0, label: '', color: '#888888' },
  'parcelNumber.segments': { name: '', description: '' },
};

// Find an "add row" template by exact path or by trailing-segment match, so per-layer
// paths (styling.layers.<id>.choropleth.categories) reuse one template.
export function templateFor(path) {
  if (ADD_TEMPLATES[path]) return ADD_TEMPLATES[path];
  const key = Object.keys(ADD_TEMPLATES).find((k) => path.endsWith('.' + k));
  return key ? ADD_TEMPLATES[key] : {};
}

/** The array at `path`, made (empty) if it isn't one yet. */
export function arrayAt(obj, path) {
  let arr = getPath(obj, path);
  if (!Array.isArray(arr)) { setPath(obj, path, []); arr = getPath(obj, path); }
  return arr;
}

export function arrayAdd(obj, path) { arrayAt(obj, path).push(clone(templateFor(path))); }

export function arrayRemove(obj, path, idx) {
  const arr = getPath(obj, path);
  if (Array.isArray(arr) && idx >= 0 && idx < arr.length) arr.splice(idx, 1);
}
