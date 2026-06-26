/**
 * pv-ledger.js — Parcel Ledger capability, LIVE + decoupled (A7c / DIC-574).
 *
 * Replaces the Parcel Packet's hardcoded sample `LEDGER` array (admin-menu.js) with
 * the real event stream from GET /parcel/{id}/history, run through the shared ledger
 * capability core (engine/capabilities/ledger.core.js):
 *
 *   fetch /parcel/{id}/history  →  ISV_LEDGER_CORE.core(events)  →  { facts, provenance }
 *                               →  ISV_LEDGER_CORE.ledgerDisplayModel(facts)  →  render
 *
 * Two-engine discipline holds even though the ledger is `no-ai`: the facts and their
 * provenance ARE the deterministic truth; there is no narration to add, so AI-off and
 * AI-on are identical (facts-parity is trivially satisfied). Provenance is native —
 * each event's source_document — with honest "recorded vs. inferred" states (§6.4).
 *
 * Decoupled from any one modal: renderLedger(facts) returns HTML the Packet section,
 * a standalone window, or a print doc can all mount. openLedger() is a convenience
 * standalone view.
 *
 * Exposes: window.PV_LEDGER
 */
(function (root) {
  'use strict';

  var T = root.PV_TEMPLATE;
  function esc(s) { return T ? T.escape(s) : String(s == null ? '' : s); }
  function apiBase() { return root.API_BASE || (root.PS_CONFIG && root.PS_CONFIG.API_BASE) || '/api'; }
  function ledgerCore() { return root.ISV_LEDGER_CORE || null; }

  // Category → display color (presentation only; the category KEY + label come from
  // the deterministic core). Mirrors the Parcel Packet palette so the look is shared.
  var CAT_COLORS = {
    ownership: '#a3473b', tax: '#b58d4a', land: '#4d7c4d',
    survey: '#3b7a8a', regulatory: '#7a5ea3', imagery: '#8a8a8a', record: '#6b7280',
  };
  function catColor(c) { return CAT_COLORS[c] || CAT_COLORS.record; }

  // ── Capability invocation (deterministic core; no model) ─────────────────────
  // Returns { facts, provenance } via the contract registry when present, else calls
  // the core directly. AI mode is irrelevant — ledger is no-ai.
  function fetchLedger(parcelId) {
    if (parcelId == null) return Promise.reject(new Error('no parcel id'));
    return fetch(apiBase() + '/parcel/' + encodeURIComponent(parcelId) + '/history', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (data) {
        var input = { events: (data && data.events) || [] };
        if (root.ISV && root.ISV.invoke) {
          return root.ISV.invoke('ledger', input, { ai: false })
            .then(function (res) { return { facts: res.facts, provenance: res.provenance }; });
        }
        var c = ledgerCore();
        if (c) return c.core(input);
        return { facts: { events: [], event_count: 0 }, provenance: [] };
      });
  }

  // ── Render (structured facts → HTML; reuses pp-ledger styles) ────────────────
  function ribbonSvg(model) {
    if (!model.span || model.span.from === model.span.to) return '';
    var y0 = model.span.from, y1 = model.span.to + 1;
    function lx(y) { return (16 + (y - y0) / (y1 - y0) * 648).toFixed(1); }
    var ticks = model.events.filter(function (e) { return e.year != null; }).map(function (e) {
      var x = lx(e.year), col = catColor(e.category);
      var dot = e.recorded
        ? '<circle cx="' + x + '" cy="20" r="3.2" fill="' + col + '"/>'
        : '<circle cx="' + x + '" cy="20" r="3" fill="var(--pp-ribbon-bg,#fff)" stroke="' + col + '" stroke-width="1.4"/>';
      return '<g class="pp-ltick"><line x1="' + x + '" y1="24" x2="' + x + '" y2="42" stroke="' + col + '" stroke-width="1.4"/>' + dot + '</g>';
    }).join('');
    return '<svg class="pp-ribbon-svg" viewBox="0 0 680 70" role="img" aria-label="Timeline of recorded events for this parcel">' +
      '<line x1="16" y1="42" x2="664" y2="42" stroke="#e5e7eb" stroke-width="1"/>' + ticks + '</svg>';
  }

  function eventRow(e) {
    var col = catColor(e.category);
    var survey = '';
    if (e.survey) {
      var bits = [];
      if (e.survey.closure_error != null) bits.push('closure ' + e.survey.closure_error + ' ft');
      if (e.survey.precision_ratio != null) bits.push('1:' + e.survey.precision_ratio);
      if (e.survey.bowditch_applied) bits.push('Bowditch-adjusted');
      if (bits.length) survey = '<div class="pp-lsurvey">' + esc(bits.join(' · ')) + '</div>';
    }
    // Provenance honesty (§6.4): a recorded event links its source document; an
    // inferred one says so plainly rather than implying a citation.
    var src = e.recorded && e.source
      ? '<a class="pp-lsrc" href="#" onclick="return false">' + esc(e.source) + ' ↗</a>'
      : '<span class="pp-lsrc pp-lsrc--none">No document of record (inferred)</span>';
    return '<li class="pp-levent" data-cat="' + esc(e.category) + '">' +
      '<button type="button" class="pp-levent-head" aria-expanded="false">' +
      '<span class="pp-ldot' + (e.recorded ? '' : ' pp-ldot--inf') + '" style="--c:' + col + '"></span>' +
      '<span class="pp-lyear">' + esc(e.year != null ? e.year : '—') + '</span>' +
      '<span class="pp-lcat" style="color:' + col + '">' + esc(e.category_label) + '</span>' +
      '<span class="pp-ltitle">' + esc(e.title) + '</span></button>' +
      '<div class="pp-lexplain" hidden>' + (e.description ? '<p>' + esc(e.description) + '</p>' : '') + survey + src + '</div></li>';
  }

  function renderLedger(facts) {
    var c = ledgerCore();
    if (!c || !c.ledgerDisplayModel) return '<p class="pv-modal-note">Ledger engine unavailable.</p>';
    var model = c.ledgerDisplayModel(facts);
    if (!model.events.length) {
      return '<p class="pv-modal-lead">No recorded events for this parcel yet.</p>' +
        '<p class="pv-modal-note">The parcel ledger lists deeds, splits, surveys, assessments, permits, and imagery as the county records them.</p>';
    }
    var legend = '<div class="pp-llegend"><span class="pp-ldot" style="--c:#6b7280"></span>recorded' +
      '<span class="pp-ldot pp-ldot--inf" style="--c:#6b7280;margin-left:10px"></span>inferred (no document of record)</div>';
    return '<div class="pv-xp">' +
      '<p class="pv-modal-lead">Every event the county has recorded for this parcel — newest first.</p>' +
      '<div class="pp-ledger-ribbon">' + ribbonSvg(model) + '</div>' + legend +
      '<div class="pp-lbody"><ul class="pp-llist">' + model.events.map(eventRow).join('') + '</ul></div>' +
      '</div>';
  }

  // Expand/collapse wiring for the event rows (event-driven, not inline handlers).
  function wireRows(bodyEl) {
    bodyEl.querySelectorAll('.pp-levent-head').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', open ? 'false' : 'true');
        var panel = btn.parentNode.querySelector('.pp-lexplain');
        if (panel) panel.hidden = open;
      });
    });
  }

  // ── Standalone opener (decoupled from the Packet modal) ──────────────────────
  // host = { openModal } (admin-menu modal owner), same contract the explainer uses.
  function openLedger(parcel, host) {
    var id = parcel && parcel.id;
    var title = 'Parcel Ledger' + (parcel && parcel.pin ? ' — ' + parcel.pin : '');
    host.openModal(title, '<div class="pv-xp-loading" role="status"><div class="pv-xp-spinner" aria-hidden="true"></div><p>Loading this parcel’s ledger…</p></div>', function (bodyEl) {
      fetchLedger(id)
        .then(function (res) { bodyEl.innerHTML = renderLedger(res.facts); wireRows(bodyEl); })
        .catch(function (err) {
          bodyEl.innerHTML = '<p class="pv-modal-lead">Couldn’t load this parcel’s ledger.</p>' +
            '<p class="pv-modal-note">' + esc((err && err.message) || 'Please try again.') + '</p>';
        });
    });
  }

  root.PV_LEDGER = {
    fetchLedger: fetchLedger,
    renderLedger: renderLedger,
    openLedger: openLedger,
    wireRows: wireRows,
  };
}(typeof window !== 'undefined' ? window : this));
