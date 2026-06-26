/**
 * ledger.core.js — deterministic core of the Ledger capability (A7c / DIC-574),
 * expressed against the A1 contract.
 *
 * Why this is the SECOND capability the contract is derived from (§4.10, §6.5):
 * it is the structural opposite of the explainer — `aiMode: 'no-ai'`, no narration,
 * and PROVENANCE THAT IS NATIVE TO THE DATA (every ledger event already carries a
 * `source_document`, `closure_error`, `precision_ratio`, `bowditch_applied`). The
 * real shape of the contract is the commonality between this and the explainer, not
 * an explainer-shaped guess.
 *
 * Source: backend GET /parcel/{id}/history → { events: [...] } (parcels.py:361).
 *
 * core(typedInput) -> { facts, provenance }
 *   typedInput = { events: LedgerEvent[] }
 *
 * UMD: Node module (harness) + browser global (window.ISV_LEDGER_CORE).
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_LEDGER_CORE = mod;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function num(v) { if (v == null || v === '') return null; var n = Number(v); return isNaN(n) ? null : n; }

  // Normalize one raw ledger row into a structured, display-ready event. No model,
  // no derivation beyond restating + typing what the row already holds.
  function normalizeEvent(e) {
    e = e || {};
    var closure = num(e.closure_error);
    var precision = num(e.precision_ratio);
    return {
      event_id: e.event_id != null ? String(e.event_id) : null,
      event_type: e.event_type || null,
      timestamp: e.event_timestamp || null,
      operator_id: e.operator_id || null,
      source_document: e.source_document || null,
      // Survey-quality signals, restated as-is (these are the trust signals a
      // register-of-deeds / surveying audience cares about).
      closure_error: closure,
      precision_ratio: precision,
      bowditch_applied: e.bowditch_applied === true,
      related_parcel_ids: Array.isArray(e.related_parcel_ids) ? e.related_parcel_ids.slice() : [],
      notes: e.notes || null,
    };
  }

  // Native provenance: each event that names a source document becomes one citation
  // envelope (§6.4). The document is the source; the event id is the anchor; a short
  // human span describes the event. 'coarse' because the ledger names the document
  // but the KB pipeline hasn't yet given a resolvable locator INTO it.
  function eventProvenance(ev) {
    if (!ev.source_document) {
      // No citable source — honest 'none' (an event with no document of record).
      return { source_id: null, anchor: ev.event_id, span: ev.event_type, state: 'none' };
    }
    var span = ev.event_type ? (ev.event_type + (ev.timestamp ? ' · ' + String(ev.timestamp).slice(0, 10) : '')) : null;
    return { source_id: ev.source_document, anchor: ev.event_id, span: span, state: 'coarse' };
  }

  // ── Deterministic display model (A7c) ───────────────────────────────────────
  // Map the raw event schema onto a presentation-ready shape WITHOUT a model: a
  // category (keyword-classified from event_type), a recorded/inferred flag (driven
  // by whether a source document of record exists), a human title, and the year.
  // This replaces the Parcel Packet's hardcoded sample LEDGER with live, typed data.
  var _CATEGORY_RULES = [
    { cat: 'survey', test: /survey|monument|retrace|bowditch|closure/ },
    { cat: 'ownership', test: /deed|convey|transfer|sale|sold|owner|grantor|grantee/ },
    { cat: 'tax', test: /tax|assess|uncap|equaliz|drain|exempt|millage|pre\b/ },
    { cat: 'land', test: /split|combine|consolidat|boundary|adjust|lot[_ ]?line|division|annex/ },
    { cat: 'regulatory', test: /permit|zoning|variance|violation|code/ },
    { cat: 'imagery', test: /imagery|aerial|photo|orthophoto/ },
  ];
  var _CATEGORY_LABELS = {
    ownership: 'Ownership', tax: 'Tax', land: 'Land', survey: 'Survey',
    regulatory: 'Permit', imagery: 'Imagery', record: 'Record',
  };

  function categorize(eventType) {
    var t = (eventType || '').toLowerCase();
    for (var i = 0; i < _CATEGORY_RULES.length; i++) {
      if (_CATEGORY_RULES[i].test.test(t)) return _CATEGORY_RULES[i].cat;
    }
    return 'record';
  }

  function humanize(eventType) {
    if (!eventType) return 'Event';
    var s = String(eventType).replace(/[_-]+/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function yearOf(ts) {
    if (!ts) return null;
    var m = /^(\d{4})/.exec(String(ts));
    return m ? parseInt(m[1], 10) : null;
  }

  // ledgerDisplayModel(facts) -> { events: [...newest-first], categories, span }
  function ledgerDisplayModel(facts) {
    var events = ((facts && facts.events) || []).map(function (e) {
      var cat = categorize(e.event_type);
      return {
        event_id: e.event_id,
        year: yearOf(e.timestamp),
        category: cat,
        category_label: _CATEGORY_LABELS[cat] || 'Record',
        recorded: !!e.source_document,            // recorded vs inferred (drives dot style)
        title: humanize(e.event_type),
        description: e.notes || null,
        source: e.source_document || null,
        survey: (e.closure_error != null || e.precision_ratio != null || e.bowditch_applied)
          ? { closure_error: e.closure_error, precision_ratio: e.precision_ratio, bowditch_applied: e.bowditch_applied }
          : null,
      };
    });
    var withYear = events.filter(function (e) { return e.year != null; });
    events.sort(function (a, b) { return (b.year || 0) - (a.year || 0); }); // newest first
    var years = withYear.map(function (e) { return e.year; });
    return {
      events: events,
      categories: events.reduce(function (set, e) {
        if (set.indexOf(e.category) < 0) set.push(e.category); return set;
      }, []),
      span: years.length ? { from: Math.min.apply(null, years), to: Math.max.apply(null, years) } : null,
    };
  }

  function core(input) {
    input = input || {};
    var raw = Array.isArray(input.events) ? input.events : [];
    var events = raw.map(normalizeEvent);
    var facts = {
      event_count: events.length,
      events: events,
      // A couple of deterministic roll-ups a UI/print can show without re-deriving.
      sourced_count: events.filter(function (e) { return !!e.source_document; }).length,
      has_survey_quality: events.some(function (e) { return e.closure_error != null || e.precision_ratio != null; }),
    };
    var provenance = events.map(eventProvenance);
    return { facts: facts, provenance: provenance };
  }

  return {
    core: core, normalizeEvent: normalizeEvent, eventProvenance: eventProvenance,
    ledgerDisplayModel: ledgerDisplayModel, categorize: categorize,
  };
}));
