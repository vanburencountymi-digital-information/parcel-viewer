/**
 * legend-panel.js — Collapsible WMS legend rows in the Layers panel.
 *
 * Wires chevron (▶/▼) buttons that appear on layer rows inside the Layers
 * pane.  When a row is first expanded the associated GetLegendGraphic image
 * is fetched lazily — no requests are made until the user opens that section.
 *
 * Buttons must have:
 *   data-target="<id>"          — id of the .lyr-legend-body div to expand
 *   data-legend-url="<url>"     — (optional) GetLegendGraphic URL to lazy-load
 *                                  Omit for rows with static inline content.
 *
 * Exposes: window.PS_LEGEND_PANEL  { expandRow, collapseRow }
 */
(function () {
  'use strict';

  /** Inject a loading spinner, then swap in the image (or an error note). */
  function _loadLegendImage(body, url, btn) {
    body.innerHTML =
      '<div class="lyr-legend-loading">' +
      '<span class="lyr-legend-spinner"></span>Loading legend…</div>';

    var img = new Image();

    img.onload = function () {
      body.innerHTML = '';
      img.className = 'lyr-legend-img';
      img.alt = 'Layer legend';
      body.appendChild(img);
    };

    img.onerror = function () {
      body.innerHTML =
        '<div class="lyr-legend-error">Legend image unavailable</div>';
    };

    img.src = url;
  }

  /** Expand one row; collapse all siblings in the same section first. */
  function _expand(btn, body) {
    btn.setAttribute('aria-expanded', 'true');
    btn.textContent = '▼'; // ▼
    body.hidden = false;

    var url = btn.dataset.legendUrl;
    // Lazy-load: only fetch the first time the row is opened
    if (url && !btn.dataset.loaded) {
      btn.dataset.loaded = '1';
      _loadLegendImage(body, url, btn);
    }
  }

  function _collapse(btn, body) {
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = '►'; // ▶
    body.hidden = true;
  }

  function _toggle(btn) {
    var targetId = btn.dataset.target;
    if (!targetId) return;
    var body = document.getElementById(targetId);
    if (!body) return;

    var expanded = btn.getAttribute('aria-expanded') === 'true';
    expanded ? _collapse(btn, body) : _expand(btn, body);
  }

  function _wireAll() {
    document.querySelectorAll('.lyr-chevron[data-target]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        // Prevent the click bubbling to the <label> and toggling the checkbox
        e.stopPropagation();
        _toggle(btn);
      });
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireAll);
  } else {
    _wireAll();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  window.PS_LEGEND_PANEL = {
    expandRow: function (targetId) {
      var btn  = document.querySelector('[data-target="' + targetId + '"]');
      var body = document.getElementById(targetId);
      if (btn && body) _expand(btn, body);
    },
    collapseRow: function (targetId) {
      var btn  = document.querySelector('[data-target="' + targetId + '"]');
      var body = document.getElementById(targetId);
      if (btn && body) _collapse(btn, body);
    }
  };
}());
