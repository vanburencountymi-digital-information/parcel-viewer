// The changelog (frontend/public/changelog.json): the app version and the What's New feed.
// Hand-curated for now; meant to be generated from Linear at build time. Loaded once.
let pending = null;

/** The changelog ({ version, releases: [{ version, date, items }] }), or null if unavailable. */
export function loadChangelog(fetch = (...a) => globalThis.fetch(...a)) {
  if (!pending) {
    pending = fetch('/frontend/public/changelog.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((d) => { if (!d) pending = null; return d; });   // retry next time after a failure
  }
  return pending;
}
