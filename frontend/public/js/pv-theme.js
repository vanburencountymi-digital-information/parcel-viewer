/**
 * pv-theme.js — theme chooser pulldown (keystone / "one engine, N themes").
 *
 * Lets a user switch between the bootable theme manifests registered in
 * engine/themes/index.json, KEEPING their current view area across the switch. The
 * pulldown is GATED: it only appears when >1 *bootable* theme is registered (today just
 * `vanburen` is PV-bootable, so it stays hidden until ZIP-as-a-theme or a second county
 * lands). Switching persists the choice (localStorage 'pv-theme') + the current camera,
 * then reloads with ?theme=<id> so the viewer boots from that theme file (pv-manifest.js).
 *
 * Additive: with ≤1 bootable theme this module renders nothing and changes no behavior.
 *
 * Exposes: window.PV_THEME_SWITCHER { refresh }
 */
(function (root) {
  'use strict';
  var doc = root.document;
  var VIEW_KEY = 'pv-view';            // transient camera snapshot, restored once after a switch
  var THEME_KEY = 'pv-theme';          // the user's chosen theme id (also read by pv-manifest)
  var VIEW_TTL_MS = 60000;             // a saved view older than this is ignored (stale)

  function lsGet(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { root.localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { root.localStorage.removeItem(k); } catch (e) {} }

  // ── View preservation across the reload ──────────────────────────────────────
  function saveView() {
    var m = root.PS_MAP;
    if (!m || !m.getCenter) return;
    var c = m.getCenter();
    lsSet(VIEW_KEY, JSON.stringify({
      c: [c.lng, c.lat], z: m.getZoom(), b: m.getBearing(), p: m.getPitch(), t: now(),
    }));
  }
  // Date.now via a tiny helper so the intent is obvious (and easy to stub in tests).
  function now() { return (new Date()).getTime(); }

  function restoreViewWhenReady() {
    var raw = lsGet(VIEW_KEY);
    if (!raw) return;
    lsDel(VIEW_KEY);                   // one-shot — clear immediately so it can't re-apply
    var v; try { v = JSON.parse(raw); } catch (e) { return; }
    if (!v || !v.c || (now() - (v.t || 0)) > VIEW_TTL_MS) return;
    var tries = 0;
    var timer = root.setInterval(function () {
      tries++;
      var m = root.PS_MAP;
      if (m && m.jumpTo) {
        m.jumpTo({ center: v.c, zoom: v.z, bearing: v.b || 0, pitch: v.p || 0 });
        root.clearInterval(timer);
      } else if (tries > 100) {        // ~10s safety cap
        root.clearInterval(timer);
      }
    }, 100);
  }

  // ── Switch ───────────────────────────────────────────────────────────────────
  function switchTheme(id) {
    if (!id) return;
    saveView();                        // keep the current view area across the reload
    lsSet(THEME_KEY, id);
    var url;
    try {
      url = new URL(root.location.href);
      url.searchParams.set('theme', id);
    } catch (e) { url = null; }
    root.location.href = url ? url.toString() : (root.location.pathname + '?theme=' + encodeURIComponent(id));
  }

  // ── Current theme id (what the pulldown should show as selected) ─────────────
  function currentThemeId(bootable) {
    if (root.PS_MANIFEST_THEME) return root.PS_MANIFEST_THEME;
    var t = root.PS_MANIFEST && root.PS_MANIFEST.tenant;
    for (var i = 0; i < bootable.length; i++) if (bootable[i].id === t) return bootable[i].id;
    return bootable.length ? bootable[0].id : null;
  }

  // ── Render the pulldown (only when >1 bootable theme) ────────────────────────
  function render(themes) {
    var bootable = (themes || []).filter(function (t) { return t && t.bootable; });
    var existing = doc.getElementById('pv-theme-switcher');
    if (bootable.length < 2) { if (existing) existing.parentNode.removeChild(existing); return; }
    if (existing) return;              // already mounted

    var bar = doc.getElementById('pv-topbar');
    if (!bar) return;
    var wrap = doc.createElement('label');
    wrap.id = 'pv-theme-switcher';
    wrap.className = 'pv-theme-switcher';
    wrap.title = 'Switch theme (keeps your current view)';
    var cur = currentThemeId(bootable);
    var opts = bootable.map(function (t) {
      return '<option value="' + t.id + '"' + (t.id === cur ? ' selected' : '') + '>' +
        String(t.label || t.id).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }) +
        '</option>';
    }).join('');
    wrap.innerHTML = '<span class="pv-sr-only">Theme</span>' +
      '<select id="pv-theme-select" class="pv-theme-select" aria-label="Theme">' + opts + '</select>';
    // Mount just before the dark-mode toggle so it sits with the other view controls.
    var anchor = doc.getElementById('theme-toggle');
    if (anchor && anchor.parentNode === bar) bar.insertBefore(wrap, anchor);
    else bar.appendChild(wrap);
    var sel = wrap.querySelector('#pv-theme-select');
    sel.addEventListener('change', function () { if (sel.value !== cur) switchTheme(sel.value); });
  }

  function refresh() {
    var pv = root.PV_MANIFEST;
    if (!pv || !pv.fetchRegistry) return;
    pv.fetchRegistry().then(render).catch(function () {});
  }

  root.PV_THEME_SWITCHER = { refresh: refresh };

  // Restore the pre-switch view (if any) + build the pulldown once the DOM is ready.
  function init() { restoreViewWhenReady(); refresh(); }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
}(typeof window !== 'undefined' ? window : this));
