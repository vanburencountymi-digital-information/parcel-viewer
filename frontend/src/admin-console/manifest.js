// The Theme Manifest's logic (B2 / DIC-578, B3 / DIC-579, B4 / DIC-580; moved from admin.js
// in DIC-2389). The manifest is canonical (§4.11), kept inside the versioned config under
// `manifest` so it rides the same draft → publish store; the engine assembles it from the
// modules' config and validates it through the same loadManifest() gate CI and the engine
// boot use. Collaborators are injected so Vitest can drive it.

// Per-source idField hints (until §5 sources land in the store).
const ID_FIELDS = { parcels: 'pin' };

/** The manifest assembled from the live config, or null without the engine. */
export function assemble(assembler, config, tenant) {
  return assembler ? assembler.assembleManifest(config || {}, { tenant, idFields: ID_FIELDS }) : null;
}

/** The manifest saved in the store (the draft's wins over the published one), or null. */
export function savedManifest(state) {
  if (state.draft && state.draft.manifest) return state.draft.manifest;
  if (state.config && state.config.manifest) return state.config.manifest;
  return null;
}

/** loadManifest() → { ok, errors, manifest, applied }. */
export function validate(loader, manifest) {
  if (!loader || !manifest) return { ok: false, errors: ['ISV engine load-manifest.js not loaded'] };
  return loader.loadManifest(manifest);
}

/** Hands the browser `obj` as a JSON file to save. */
export function downloadJson(doc, name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  doc.body.appendChild(a);
  a.click();
  doc.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Whether the AI service answers its /health within 4 s. */
export async function aiReachable({ fetch, base }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(base() + '/health', { signal: ctrl.signal, cache: 'no-store' });
    return !!(r && r.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The AI's review of a deterministic draft (B3): POST /autoconfigure → { rationale,
 * suggestions } or null. Additive: the draft stands whatever happens here. This calls the
 * live model.
 */
export async function aiReview({ fetch, base }, body) {
  try {
    const r = await fetch(base() + '/autoconfigure', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify(body),
    });
    const res = r.ok ? await r.json() : null;
    return (res && res.ok && res.refinement) || null;
  } catch {
    return null;
  }
}
