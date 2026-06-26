/**
 * pv-ai-mode.js — AI-mode toggle controller (B1 / DIC-571).
 *
 * AI is OPT-IN (§4.4a): default OFF. The top-panel toggle flips PV_PREFS.getAiMode/
 * setAiMode (persisted), and this controller applies the mode everywhere:
 *   - `data-ai-mode="on|off"` on <html> so any component/CSS can react,
 *   - the Map Buddy panel is hidden when off (§4.5 "Map Buddy chat → hidden"),
 *   - explainers already read PV_PREFS.getAiMode() and degrade to facts + statute
 *     links when off (A7a),
 *   - the toggle button reflects state (aria-pressed + accent when on).
 *
 * Auto-fallback when the AI service is unreachable (§4.4b) is B4 (a shared health
 * check) — this controller already exposes a forced-off path for it to call.
 *
 * Exposes: window.PV_AI_MODE { get, set, isOn, toggle }
 */
(function (root) {
  'use strict';
  var doc = root.document;

  function prefs() { return root.PV_PREFS || null; }
  function get() {
    var p = prefs();
    return (p && typeof p.getAiMode === 'function') ? p.getAiMode() : 'off';
  }
  function isOn() { return get() === 'on'; }

  // Inject the degrade-to-facts CSS once. Keying on data-ai-mode hides AI surfaces
  // (Map Buddy) even when they're built lazily — no timing dependence.
  function ensureStyle() {
    if (doc.getElementById('pv-ai-mode-style')) return;
    var s = doc.createElement('style');
    s.id = 'pv-ai-mode-style';
    s.textContent = 'html[data-ai-mode="off"] #map-buddy-panel{display:none !important;}';
    (doc.head || doc.documentElement).appendChild(s);
  }

  function apply(mode) {
    var on = mode === 'on';
    ensureStyle();
    if (doc.documentElement) doc.documentElement.setAttribute('data-ai-mode', on ? 'on' : 'off');

    // Toggle button state.
    var btn = doc.getElementById('pv-ai-toggle');
    if (btn) {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = 'AI mode: ' + (on ? 'on' : 'off');
      btn.classList.toggle('is-on', on);
      // Accent when on so state is legible without bespoke CSS.
      btn.style.color = on ? 'var(--ui-interactive, #B58D4A)' : '';
    }
  }

  function set(mode) {
    var p = prefs();
    var m = (mode === 'on') ? 'on' : 'off';
    if (p && typeof p.setAiMode === 'function') p.setAiMode(m); // persists + dispatches
    else apply(m);
    return m;
  }
  function toggle() { return set(isOn() ? 'off' : 'on'); }

  function wire() {
    var btn = doc.getElementById('pv-ai-toggle');
    if (btn && !btn._pvAiWired) {
      btn._pvAiWired = true;
      btn.addEventListener('click', function () { toggle(); });
    }
    // Re-apply whenever the mode changes (from the button, settings, or B4 fallback).
    root.addEventListener('pv-ai-mode-change', function (e) {
      apply((e && e.detail && e.detail.mode) || get());
    });
    apply(get());
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', wire);
  else wire();

  root.PV_AI_MODE = { get: get, set: set, isOn: isOn, toggle: toggle, apply: apply };
}(typeof window !== 'undefined' ? window : this));
