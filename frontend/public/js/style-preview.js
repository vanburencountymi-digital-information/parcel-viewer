/**
 * style-preview.js — local draft preview bridge (DIC-512, seeds DIC-466).
 *
 * Lets the Admin Console preview UNSAVED config edits in the viewer WITHOUT the
 * writable store (which is 503 locally). The admin writes its draft to
 * localStorage 'pv-config-preview'; here — loaded after county-config.js and
 * /api/config.js, before map.js reads window.COUNTY — we deep-merge that draft
 * over window.COUNTY so the map renders the draft.
 *
 * Purely client-side, same 127.0.0.1 origin. Nothing hits the server, and a real
 * visitor never has the key, so the published config is untouched for them. A
 * fixed banner makes the preview obvious and offers a one-click exit.
 */
(function () {
  'use strict';

  var KEY = 'pv-config-preview';

  // Deep-merge `over` onto `base`. Arrays + scalars from `over` win wholesale;
  // plain objects merge key-by-key. (The admin draft is a full manifest clone, so
  // this faithfully reflects edits; structural removals are an accepted edge.)
  function deepMerge(base, over) {
    if (over === null || over === undefined) return base;
    if (Array.isArray(over) || typeof over !== 'object') return over;
    if (!base || typeof base !== 'object' || Array.isArray(base)) return over;
    var out = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) {
      out[k] = (k in out) ? deepMerge(out[k], over[k]) : over[k];
    }
    return out;
  }

  var raw = null;
  try { raw = localStorage.getItem(KEY); } catch (_) { raw = null; }
  if (!raw) return;

  var draft;
  try { draft = JSON.parse(raw); } catch (_) { return; }
  if (!draft || typeof draft !== 'object') return;

  window.COUNTY = deepMerge(window.COUNTY || {}, draft);
  window.PV_PREVIEW_ACTIVE = true;

  function showBanner() {
    if (document.getElementById('pv-preview-banner')) return;
    var b = document.createElement('div');
    b.id = 'pv-preview-banner';
    b.setAttribute('role', 'status');
    b.style.cssText = [
      'position:fixed', 'bottom:16px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:9999', 'display:flex', 'align-items:center', 'gap:12px',
      'background:#2d1613', 'color:#f2e6d8', 'padding:8px 10px 8px 16px',
      'border-radius:999px', 'box-shadow:0 6px 22px rgba(0,0,0,.35)',
      'font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif',
    ].join(';');
    var dot = '<span style="color:#e8a04f">●</span> Previewing unsaved draft';
    b.innerHTML = '<span>' + dot + '</span>';
    var exit = document.createElement('button');
    exit.type = 'button';
    exit.textContent = 'Exit preview';
    exit.style.cssText = 'background:#b58d4a;color:#2d1613;border:0;border-radius:999px;' +
      'font:700 12px system-ui,sans-serif;padding:5px 11px;cursor:pointer';
    exit.addEventListener('click', function () {
      try { localStorage.removeItem(KEY); } catch (_) {}
      location.reload();
    });
    b.appendChild(exit);
    document.body.appendChild(b);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showBanner);
  else showBanner();

  // Near-live loop: when the admin pushes a new draft (writes the key from its
  // tab), reload this tab so the new draft applies.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) location.reload();
  });
}());
