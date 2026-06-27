/**
 * pv-citations.js — the Citation Renderer's viewer surface (DIC-522, §6.4).
 *
 * Mounts the in-app, synchronized "Sources" doc panel and drives it from the engine's
 * source-agnostic citation core (ISV_CITATION). When a citation is activated on the bus
 * (e.g. clicking an explainer statute link), this resolves the §6.4 envelope against a
 * DOCUMENT RESOLVER and renders the cited source into #pv-doc-panel — scrolled/focused,
 * with the honest degradation state (resolves / coarse / none).
 *
 * v1 resolver = the curated MI tax-statute corpus (the same provenance universe the
 * explainer cites). The resolver is the ONLY statute-aware piece; swap in a KnowledgeStore/
 * KB resolver later ("anything in the KB") and nothing else changes — that's the seam.
 *
 * Capability-gated: only active when manifest.capabilities.citations is enabled (PV_CAPS).
 * Bus-driven (not a detached window) so the map + AI + docs stay interrelated.
 *
 * Exposes: window.PV_CITATIONS { open, close, activate, isEnabled }.
 * Listens:  PS_BUS 'citation-activated'  (detail = an envelope, or {envelope}/{envelopes,focus}).
 */
(function (root) {
  'use strict';

  function bus() { return root.PS_BUS || (root.PS_CONTEXT && root.PS_CONTEXT.bus) || null; }
  function caps() { return root.PV_CAPS || null; }
  function enabled() { var c = caps(); return c ? c.isEnabled('citations') : true; }  // default-on if no gate
  function engine() { return root.ISV_CITATION || null; }
  function el(id) { return root.document && root.document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ── Document resolver (v1: curated statute corpus) ──────────────────────────
  var _corpus = null;   // statutes array, lazy-loaded
  function loadCorpus() {
    if (_corpus) return Promise.resolve(_corpus);
    return fetch('/engine/data/mi-tax-statutes.json', { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : { statutes: [] }; })
      .then(function (j) { _corpus = (j && j.statutes) || []; return _corpus; })
      .catch(function () { _corpus = []; return _corpus; });
  }
  // resolver(envelope) -> doc | null. Matches by anchor (mcl) / source_id (citation) / span (name).
  // Whole-statute, so anchorResolved is false → the engine floors the state to 'coarse'.
  function statuteResolver(env) {
    var list = _corpus || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s.mcl === env.anchor || s.citation === env.source_id || s.name === env.span) {
        return { id: s.mcl, title: s.name, citation: s.citation, body: s.plain, url: s.url,
                 anchorResolved: false, state: s.state };
      }
    }
    return null;
  }

  // ── Panel render ────────────────────────────────────────────────────────────
  var STATE_LABEL = {
    resolves: 'Source resolved',
    coarse: 'Source — section approximate',
    none: 'No citable source',
  };

  function renderOne(rendered) {
    var stateEl = el('pv-doc-state'), body = el('pv-doc-body');
    if (!body) return;
    if (stateEl) {
      stateEl.hidden = false;
      stateEl.textContent = STATE_LABEL[rendered.state] || rendered.state;
      stateEl.setAttribute('data-state', rendered.state);
    }
    if (!rendered.found || rendered.state === 'none') {
      // Honest degradation: an uncitable claim renders nothing but SAYS so.
      body.innerHTML = '<p class="pv-doc-none">No authoritative source is available for this' +
        ' citation. (An AI claim without a citable source is not shown as fact.)</p>';
      return;
    }
    var title = esc(rendered.title || rendered.citation || 'Source');
    var cite = rendered.citation ? '<div class="pv-doc-cite">' + esc(rendered.citation) + '</div>' : '';
    var passage = rendered.body ? '<div class="pv-doc-passage">' + esc(rendered.body) + '</div>' : '';
    var link = rendered.url
      ? '<a class="pv-doc-source-link" href="' + esc(rendered.url) + '" target="_blank" rel="noopener noreferrer">View official source ↗</a>'
      : '';
    body.innerHTML = '<article class="pv-doc-entry"><h3 class="pv-doc-h">' + title + '</h3>' +
      cite + passage + link + '</article>';
    body.scrollTop = 0;
  }

  // ── Open / close ──────────────────────────────────────────────────────────
  function showPanel(on) {
    var panel = el('pv-doc-panel');
    if (panel) panel.hidden = !on;
    var mtab = el('pv-mtab-docs');
    if (mtab) { mtab.hidden = !on; mtab.setAttribute('aria-selected', on ? 'true' : 'false'); }
    if (on && panel && panel.focus) { try { panel.focus({ preventScroll: true }); } catch (_) { } }
  }

  // Resolve + render one envelope into the panel.
  function activate(envelope) {
    if (!enabled() || !envelope) return;
    var eng = engine();
    if (!eng) return;
    loadCorpus().then(function () {
      var rendered = eng.resolveCitation(envelope, statuteResolver);
      renderOne(rendered);
      showPanel(true);
    });
  }

  function open() { showPanel(true); }
  function close() { showPanel(false); }

  // ── Wiring ────────────────────────────────────────────────────────────────
  function init() {
    var closeBtn = el('pv-doc-close');
    if (closeBtn) closeBtn.addEventListener('click', close);

    var b = bus();
    if (b && b.on) {
      b.on('citation-activated', function (detail) {
        // detail may be a raw envelope, or { envelope } / { envelopes, focus }
        var env = detail && (detail.envelope || (Array.isArray(detail.envelopes) ? (detail.envelopes[detail.focus || 0]) : detail));
        activate(env);
      });
    }

    // Generic citation triggers: ANY element carrying data-cite-source becomes a clickable
    // citation (the explainer's statute links use this). Delegated so it covers HTML injected
    // later. Builds the minimal §6.4 envelope; the resolver fills the rest from the corpus/KB.
    if (root.document) {
      root.document.addEventListener('click', function (e) {
        var t = e.target && e.target.closest && e.target.closest('[data-cite-source]');
        if (!t || !enabled()) return;
        e.preventDefault();
        var env = {
          source_id: t.getAttribute('data-cite-source') || null,
          anchor: t.getAttribute('data-cite-anchor') || null,
          span: t.getAttribute('data-cite-span') || null,
        };
        var bb = bus();
        if (bb && bb.emit) bb.emit('citation-activated', env);   // keep the bus as the seam
        else activate(env);
      });
    }
  }

  root.PV_CITATIONS = { open: open, close: close, activate: activate, isEnabled: enabled };

  if (root.document && root.document.readyState !== 'loading') init();
  else if (root.document) root.document.addEventListener('DOMContentLoaded', init);
}(typeof self !== 'undefined' ? self : this));
