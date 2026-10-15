// Street View for the selected parcel (DIC-2389; was admin-menu.js's openStreetView).
//
// Where the camera stands (the viewpoint) and what it looks at come from the API: the
// parcel's address point (/streetview-target), else the nearest road to its centroid
// (/nearest-road), else the centroid itself. With the county's Google Maps embed key the
// view opens in the viewer's window; without one, Google Maps opens in a new tab.

/** Compass heading from the viewpoint to the target, or null when they're the same spot. */
export function heading(vp, lookAt, turf) {
  try {
    if (turf && lookAt && (vp[0] !== lookAt[0] || vp[1] !== lookAt[1])) {
      return Math.round(((turf.bearing([vp[0], vp[1]], [lookAt[0], lookAt[1]]) % 360) + 360) % 360);
    }
  } catch { /* no heading then */ }
  return null;
}

/** Google Maps' own Street View page at the viewpoint, facing the target. */
export function mapsUrl(vp, lookAt, turf) {
  const h = heading(vp, lookAt, turf);
  return 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint='
    + encodeURIComponent(`${vp[1]},${vp[0]}`) + (h != null ? `&heading=${h}` : '');
}

/** The Maps Embed API's Street View (free; the key is referrer-restricted). */
export function embedUrl(key, vp, lookAt, turf) {
  const h = heading(vp, lookAt, turf);
  return `https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(key)}`
    + `&location=${encodeURIComponent(`${vp[1]},${vp[0]}`)}`
    + (h != null ? `&heading=${h}` : '') + '&pitch=0&fov=90';
}

/** The parcel's centroid [lng, lat], or null when it has none. */
export function centroidOf(parcel) {
  const c = parcel && parcel.centroid;
  return c && c[0] != null && c[1] != null ? c : null;
}

/** Resolves { vp, lookAt, address } for the parcel; never rejects (falls back to the centroid). */
export async function resolveTarget(parcel, { base, fetchFn = globalThis.fetch }) {
  const c = centroidOf(parcel);
  const json = async (url) => (await fetchFn(url)).json();
  if (parcel.id != null) {
    try {
      const d = await json(`${base}/streetview-target?id=${encodeURIComponent(parcel.id)}`);
      if (d && d.ok && d.viewpoint) return { vp: d.viewpoint, lookAt: d.lookAt || c, address: d.address || null };
    } catch { /* try the nearest road */ }
  }
  try {
    const d = await json(`${base}/nearest-road?lng=${c[0]}&lat=${c[1]}`);
    return { vp: d && d.lng != null ? [d.lng, d.lat] : c, lookAt: c, address: null };
  } catch {
    return { vp: c, lookAt: c, address: null };
  }
}
