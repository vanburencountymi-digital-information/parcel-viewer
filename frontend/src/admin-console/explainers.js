// The explainer plugins, from the Map Buddy service's GET /explainers (DIC-459; moved from
// admin.js in DIC-2389). Each is a callable plugin with its own LLM context: system
// prompt, injected reference material, and model.

/** Resolves { explainers } or { error } (e.g. "HTTP 502"), never rejects. */
export async function loadExplainers({ fetch, base }) {
  try {
    const r = await fetch(base() + '/explainers', { cache: 'no-cache' });
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const res = await r.json();
    return { explainers: (res && res.explainers) || [] };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}
