/**
 * citation.js — source-agnostic Citation Renderer core (§6.4 / DIC-522).
 *
 * Every AI surface that cites emits the SAME envelope (§6.4):
 *   { source_id, anchor, span, state }   (+ optional display hints: title, citation, url, body)
 * This module turns one such envelope into a render-ready result by resolving it against an
 * INJECTED document resolver, and computes an honest degradation state. The viewer mounts a
 * surface (a doc panel) and renders the result; the engine knows "a citation against a
 * resolver", never a domain noun — so the SAME renderer serves PV (MI tax statutes) and ZIP
 * (zoning ordinance), and any future KB-backed source.
 *
 * resolveCitation(envelope, resolver) -> rendered
 *   resolver(envelope) -> doc | null
 *     doc = { id?, title?, citation?, body?, url?, anchorResolved?, state? }
 *          (anchorResolved: true when the anchor locates a precise passage inside body)
 *   rendered = { source_id, anchor, span, title, citation, body, url, found, state }
 *
 * Degradation (§6.4), conservative — never over-claim:
 *   - 'resolves' : a document was found AND the anchor locates a precise passage.
 *   - 'coarse'   : a document was found but the anchor is approximate / whole-document.
 *   - 'none'     : no citable document — the surface renders nothing and SAYS so
 *                  (an uncitable AI claim is treated as freelancing, not a citation).
 *
 * UMD: Node module (harness) + browser global (window.ISV_CITATION).
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_CITATION = mod;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STATES = { RESOLVES: 'resolves', COARSE: 'coarse', NONE: 'none' };
  var RANK = { none: 0, coarse: 1, resolves: 2 };

  function isObj(v) { return v != null && typeof v === 'object'; }
  function pick() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  }
  // The conservative (lower-rank) of two states — so a declared 'coarse' can never be
  // promoted to 'resolves' by the renderer, but a precise resolution can downgrade.
  function floorState(a, b) {
    var ra = RANK[a] == null ? RANK.coarse : RANK[a];
    var rb = RANK[b] == null ? RANK.coarse : RANK[b];
    var r = Math.min(ra, rb);
    return r === 0 ? STATES.NONE : (r === 1 ? STATES.COARSE : STATES.RESOLVES);
  }

  // Resolve a single citation envelope against an injected document resolver.
  function resolveCitation(envelope, resolver) {
    var env = isObj(envelope) ? envelope : {};
    var doc = null;
    try { doc = (typeof resolver === 'function') ? resolver(env) : null; } catch (_) { doc = null; }

    if (!isObj(doc)) {
      // No citable document — honest "none" (render nothing + say so).
      return {
        source_id: env.source_id || null,
        anchor: env.anchor || null,
        span: env.span || null,
        title: null, citation: env.source_id || null, body: null, url: env.url || null,
        found: false, state: STATES.NONE,
      };
    }

    // Computed precision: a precise passage requires both an anchor AND the resolver
    // confirming it located that passage in the document.
    var precise = !!(env.anchor && doc.anchorResolved);
    var computed = precise ? STATES.RESOLVES : STATES.COARSE;
    // Honor any declared state as a ceiling (the emitter / corpus may already know it's coarse).
    var declared = pick(doc.state, env.state, STATES.COARSE);
    var state = floorState(computed, declared);

    return {
      source_id: pick(doc.id, env.source_id),
      anchor: pick(env.anchor, doc.id),
      span: env.span || null,
      title: pick(doc.title, env.span, doc.id, env.source_id),
      citation: pick(doc.citation, env.source_id, doc.title),
      body: pick(doc.body, env.plain),
      url: pick(doc.url, env.url),
      found: true,
      state: state,
    };
  }

  // Resolve a list of envelopes; keeps order, drops nothing (callers can filter by state).
  function resolveCitations(envelopes, resolver) {
    return (Array.isArray(envelopes) ? envelopes : []).map(function (e) {
      return resolveCitation(e, resolver);
    });
  }

  return {
    STATES: STATES,
    resolveCitation: resolveCitation,
    resolveCitations: resolveCitations,
    floorState: floorState,
  };
}));
