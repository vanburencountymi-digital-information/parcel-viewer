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

  // Availability (B4 / DIC-580) is SEPARATE from the user's preference: if the user
  // wants AI on but the service is unreachable, we degrade to facts WITHOUT changing
  // their choice, then re-enable on recovery. Effective AI = wanted AND available.
  var _available = true;
  function isAvailable() { return _available; }
  function isEffective() { return isOn() && _available; }
  function setAvailable(avail) {
    var a = !!avail;
    if (a === _available) return;
    _available = a;
    apply();
    try { root.dispatchEvent(new CustomEvent('pv-ai-availability-change', { detail: { available: a } })); } catch (_) {}
  }

  // Inject the degrade-to-facts CSS once. Keying on data-ai-mode hides AI surfaces
  // (Map Buddy) even when they're built lazily — no timing dependence.
  function ensureStyle() {
    if (doc.getElementById('pv-ai-mode-style')) return;
    var s = doc.createElement('style');
    s.id = 'pv-ai-mode-style';
    s.textContent = 'html[data-ai-mode="off"] #map-buddy-panel{display:none !important;}';
    (doc.head || doc.documentElement).appendChild(s);
  }

  // A calm, persistent notice while AI is wanted but unavailable (§4.4b). Reuses the
  // existing .pv-toast styling.
  function notice(show) {
    var el = doc.getElementById('pv-ai-notice');
    if (show && !el) {
      el = doc.createElement('div');
      el.id = 'pv-ai-notice';
      el.className = 'pv-toast';
      el.setAttribute('role', 'status');
      el.textContent = 'AI is unavailable right now — showing facts. Retrying…';
      (doc.body || doc.documentElement).appendChild(el);
      if (root.requestAnimationFrame) root.requestAnimationFrame(function () { el.classList.add('pv-toast--show'); });
      else el.classList.add('pv-toast--show');
    } else if (!show && el) {
      el.classList.remove('pv-toast--show');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }
  }

  // Reflect the EFFECTIVE state (no arg — always recomputed from preference +
  // availability). data-ai-mode follows effective; the button shows user intent.
  function apply() {
    ensureStyle();
    var userOn = isOn();
    var effective = userOn && _available;
    if (doc.documentElement) doc.documentElement.setAttribute('data-ai-mode', effective ? 'on' : 'off');

    var btn = doc.getElementById('pv-ai-toggle');
    if (btn) {
      btn.setAttribute('aria-pressed', userOn ? 'true' : 'false');
      btn.title = userOn ? (effective ? 'AI mode: on' : 'AI mode: on (service unavailable — showing facts)') : 'AI mode: off';
      btn.classList.toggle('is-on', userOn);
      btn.classList.toggle('is-degraded', userOn && !_available);
      btn.style.color = effective ? 'var(--ui-interactive, #B58D4A)' : '';
    }
    notice(userOn && !_available);
  }

  function set(mode) {
    var p = prefs();
    var m = (mode === 'on') ? 'on' : 'off';
    if (p && typeof p.setAiMode === 'function') p.setAiMode(m); // persists + dispatches → apply()
    else apply();
    return m;
  }
  function toggle() { return set(isOn() ? 'off' : 'on'); }

  function wire() {
    var btn = doc.getElementById('pv-ai-toggle');
    if (btn && !btn._pvAiWired) {
      btn._pvAiWired = true;
      btn.addEventListener('click', function () { toggle(); });
    }
    // Re-apply whenever the mode changes (button, settings, or the B4 fallback).
    root.addEventListener('pv-ai-mode-change', function () { apply(); });
    apply();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', wire);
  else wire();

  root.PV_AI_MODE = {
    get: get, set: set, isOn: isOn, toggle: toggle, apply: apply,
    isAvailable: isAvailable, isEffective: isEffective, setAvailable: setAvailable,
  };
}(typeof window !== 'undefined' ? window : this));
