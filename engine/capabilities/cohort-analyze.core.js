/**
 * cohort-analyze.core.js — deterministic core of the Cohort Analysis capability
 * (DIC-587), expressed against the A1 contract.
 *
 * The engine behind the analysis suite: Compare (DIC-589) and the Neighborhood / Area
 * Profile (DIC-588) are both PRESETS over this one machine. A "cohort" is a SET of
 * features (the spatial SELECTION — buffer / adjacency / named-geography / explicit —
 * is the backend's job; the features are passed in as typed input, §6.1). This core
 * runs deterministic AGGREGATORS over that set → structured FACTS + PROVENANCE, with NO
 * model call and NO globals (§4.3). The AI half (a plain-language "character" read) is a
 * separate narrate() caller over these same facts (§4.6 facts-parity).
 *
 * SOURCE-AGNOSTIC (§4.1): this module knows "a feature set", "a category field", "value
 * fields", "an area field", "an owner field" — NEVER a domain noun. Which properties play
 * those roles is CONFIG (`input.fields`), exactly like the popup/explainer label maps. So
 * the same core profiles an assessment roll, zoning districts, or any other source.
 *
 * core(typedInput) -> { facts, provenance }
 *   typedInput = { cohort, fields, aggregators?, source_id? }
 *     cohort:   { selector:{type,label,...}, features:[{ id, properties:{...} }] }
 *     fields:   { area?, category?, categoryLabels?, secondaryCategory?, secondaryLabels?,
 *                 owner?, values?:[{key, prev?, label?}] }
 *     aggregators?: subset of ['composition','value-stats','value-change','ownership',
 *                   'area-distribution'] — defaults to every one the fields support.
 *     source_id?:   provenance label for the data lineage (e.g. 'assessment-roll').
 *
 * UMD: Node module (harness) + browser global (window.ISV_COHORT_ANALYZE_CORE).
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_COHORT_ANALYZE_CORE = mod;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toNum(v) { if (v == null || v === '') return null; var n = Number(v); return isNaN(n) ? null : n; }
  function round(n, dp) { if (n == null) return null; var f = Math.pow(10, dp == null ? 2 : dp); return Math.round(n * f) / f; }
  function share(n, total) { return total ? round(n / total, 4) : 0; }

  // Descriptive stats over the non-null numbers in `arr`. Pure.
  function stats(arr) {
    var xs = (arr || []).map(toNum).filter(function (n) { return n != null; });
    var n = xs.length;
    if (!n) return { count: 0, sum: 0, mean: null, median: null, min: null, max: null };
    var sorted = xs.slice().sort(function (a, b) { return a - b; });
    var sum = 0;
    for (var i = 0; i < n; i++) sum += sorted[i];
    var mid = Math.floor(n / 2);
    var median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return { count: n, sum: round(sum, 2), mean: round(sum / n, 2), median: round(median, 2),
             min: sorted[0], max: sorted[n - 1] };
  }

  function props(features) {
    return (features || []).map(function (f) { return (f && f.properties) || {}; });
  }
  function col(features, key) {
    if (!key) return [];
    return props(features).map(function (p) { return p[key]; });
  }
  function resolveLabel(maps, code) {
    if (code == null || code === '') return null;
    var c = String(code).trim();
    return (maps && maps[c]) || c;
  }

  // ── Aggregators (each PURE: (features, fields) -> a facts fragment) ───────────

  // composition: count, area summary, and a category mix (+ optional secondary mix).
  function composition(features, fields) {
    var out = { count: (features || []).length };
    if (fields.area) out.area = stats(col(features, fields.area));
    if (fields.category) out.categoryMix = mix(features, fields.category, fields.categoryLabels, fields.area);
    if (fields.secondaryCategory) out.secondaryMix = mix(features, fields.secondaryCategory, fields.secondaryLabels, fields.area);
    return out;
  }
  // A category breakdown: per distinct value → count, summed area, share. Sorted by count desc.
  function mix(features, key, labels, areaKey) {
    var byKey = {}, total = (features || []).length, areaTotal = 0;
    props(features).forEach(function (p) {
      var raw = p[key];
      var k = (raw == null || raw === '') ? '(none)' : String(raw).trim();
      var a = areaKey ? (toNum(p[areaKey]) || 0) : 0;
      areaTotal += a;
      if (!byKey[k]) byKey[k] = { key: k, label: resolveLabel(labels, k), count: 0, area: 0 };
      byKey[k].count += 1; byKey[k].area += a;
    });
    return Object.keys(byKey).map(function (k) {
      var e = byKey[k];
      return { key: e.key, label: e.label, count: e.count, area: round(e.area, 2),
               share: share(e.count, total), areaShare: share(e.area, areaTotal) };
    }).sort(function (a, b) { return b.count - a.count; });
  }

  // value-stats: descriptive stats per configured value field, plus per-area intensity.
  function valueStats(features, fields) {
    var out = {};
    var areaSum = fields.area ? stats(col(features, fields.area)).sum : null;
    (fields.values || []).forEach(function (v) {
      var s = stats(col(features, v.key));
      s.label = v.label || v.key;
      s.perArea = (areaSum && s.sum != null) ? round(s.sum / areaSum, 2) : null;
      out[v.key] = s;
    });
    return out;
  }

  // value-change: current vs prior period per value field (needs a `prev` mapping).
  function valueChange(features, fields) {
    var out = {};
    (fields.values || []).forEach(function (v) {
      if (!v.prev) return;
      var curr = 0, prev = 0, up = 0, down = 0, flat = 0, n = 0;
      props(features).forEach(function (p) {
        var c = toNum(p[v.key]), q = toNum(p[v.prev]);
        if (c == null || q == null) return;
        n += 1; curr += c; prev += q;
        if (c > q) up += 1; else if (c < q) down += 1; else flat += 1;
      });
      if (!n) return;
      out[v.key] = {
        label: v.label || v.key, count: n,
        currentTotal: round(curr, 2), priorTotal: round(prev, 2),
        deltaTotal: round(curr - prev, 2), deltaPct: prev ? round((curr - prev) / prev, 4) : null,
        up: up, down: down, flat: flat,
      };
    });
    return out;
  }

  // ownership: identity concentration over the owner field (assemblage / consolidation
  // signal). Blank/unmatched owners are SEPARATED into unknownCount (not a real owner), so
  // they can't masquerade as a single dominant holder — concentration is over KNOWN owners.
  function ownership(features, fields) {
    var total = (features || []).length;
    var byOwner = {}, unknown = 0;
    col(features, fields.owner).forEach(function (raw) {
      var k = (raw == null || String(raw).trim() === '') ? null : String(raw).trim();
      if (k == null) { unknown++; return; }
      byOwner[k] = (byOwner[k] || 0) + 1;
    });
    var knownTotal = total - unknown;
    var owners = Object.keys(byOwner).map(function (k) {
      return { owner: k, count: byOwner[k], share: share(byOwner[k], knownTotal) };
    }).sort(function (a, b) { return b.count - a.count; });
    var hhi = 0;
    owners.forEach(function (o) { hhi += o.share * o.share; });
    return {
      total: total,
      unknownCount: unknown,                                    // blank / unmatched owner field
      distinctOwners: owners.length,                            // distinct KNOWN owners
      topOwner: owners[0] || null,                              // share over the KNOWN total
      multiFeatureOwners: owners.filter(function (o) { return o.count > 1; }).length,
      concentrationHHI: owners.length ? round(hhi, 4) : 0,      // 1 = one owner holds all known
    };
  }

  // area-distribution: a histogram of the area field over configurable upper edges.
  function areaDistribution(features, fields, edges) {
    edges = (edges && edges.length) ? edges.slice().sort(function (a, b) { return a - b; }) : [1, 5, 20, 40];
    var buckets = [];
    for (var i = 0; i <= edges.length; i++) {
      var lo = i === 0 ? 0 : edges[i - 1];
      var hi = i < edges.length ? edges[i] : null;
      buckets.push({ min: lo, max: hi, label: hi == null ? ('≥ ' + lo) : (lo + '–' + hi), count: 0 });
    }
    col(features, fields.area).map(toNum).forEach(function (a) {
      if (a == null) return;
      var idx = edges.length;
      for (var i = 0; i < edges.length; i++) { if (a < edges[i]) { idx = i; break; } }
      buckets[idx].count += 1;
    });
    return { edges: edges, buckets: buckets };
  }

  // environmental: composition of the area by environmental constraint — flood-zone mix +
  // share in a special flood hazard area, wetland coverage (features touching + acreage), and
  // soil-class mix. SOURCE-AGNOSTIC and CLIP-READY: it reads per-feature environmental FIELDS
  // (config in fields.environmental), so it produces nothing today (the assessment roll carries
  // no environmental columns) and lights up with REAL numbers the moment those fields exist —
  // e.g. once wetlands are a county PostGIS overlay and per-feature wetland acreage is clipped
  // into each feature (the roadmap). Until then the viewer shows a coarse center-point read.
  function truthy(v) {
    if (v == null) return false;
    var s = String(v).trim().toLowerCase();
    return s === 't' || s === 'true' || s === 'y' || s === 'yes' || s === '1';
  }
  function environmental(features, fields) {
    var env = fields.environmental || {};
    var areaKey = env.area || fields.area;
    var out = {}, total = (features || []).length;
    var ps = props(features);

    if (env.floodZone || env.floodFlag) {
      var inSfha = 0, counted = 0;
      ps.forEach(function (p) {
        var f = env.floodFlag ? p[env.floodFlag] : null;
        if (env.floodFlag) { counted += 1; if (truthy(f)) inSfha += 1; }
      });
      out.flood = {};
      if (env.floodZone) out.flood.zoneMix = mix(features, env.floodZone, env.floodLabels, areaKey);
      if (env.floodFlag) { out.flood.inSfhaCount = inSfha; out.flood.inSfhaShare = share(inSfha, counted); }
    }

    if (env.wetlandAcres || env.wetlandFlag) {
      var withW = 0, wAcres = 0, areaTotal = 0;
      ps.forEach(function (p) {
        var a = env.wetlandAcres ? (toNum(p[env.wetlandAcres]) || 0) : 0;
        var hit = env.wetlandAcres ? a > 0 : truthy(p[env.wetlandFlag]);
        if (hit) withW += 1;
        wAcres += a;
        if (areaKey) areaTotal += (toNum(p[areaKey]) || 0);
      });
      out.wetland = { withWetlandCount: withW, withWetlandShare: share(withW, total) };
      if (env.wetlandAcres) {
        out.wetland.wetlandAcres = round(wAcres, 2);
        out.wetland.wetlandAcreShare = areaTotal ? round(wAcres / areaTotal, 4) : 0;
      }
    }

    if (env.soilClass) out.soil = { soilMix: mix(features, env.soilClass, env.soilLabels, areaKey) };
    return out;
  }

  // compare: transpose the cohort into a (field × feature) table with per-row diff marking
  // — the explicit-cohort "identity + diff" preset (DIC-589). compareFields = [{key,label}];
  // columnLabel names the property used as each column header (e.g. the id field).
  function compare(features, fields) {
    var cfs = fields.compareFields || [];
    var columns = (features || []).map(function (f) {
      var p = (f && f.properties) || {};
      return { id: f && f.id != null ? f.id : null, label: fields.columnLabel ? p[fields.columnLabel] : (f && f.id) };
    });
    var rows = cfs.map(function (cf) {
      var values = props(features).map(function (p) { var v = p[cf.key]; return v === undefined ? null : v; });
      var seen = {}, distinct = 0;
      values.forEach(function (v) { var k = v == null ? ' ' : String(v); if (!seen[k]) { seen[k] = 1; distinct++; } });
      return { field: cf.key, label: cf.label || cf.key, values: values, differs: distinct > 1 };
    });
    return { columns: columns, rows: rows };
  }

  // Which aggregators the configured fields can actually support.
  function supported(fields) {
    var s = [];
    if (fields.category || fields.area) s.push('composition');
    if ((fields.values || []).length) s.push('value-stats');
    if ((fields.values || []).some(function (v) { return v.prev; })) s.push('value-change');
    if (fields.owner) s.push('ownership');
    if (fields.area) s.push('area-distribution');
    var env = fields.environmental || {};
    if (env.floodZone || env.floodFlag || env.wetlandAcres || env.wetlandFlag || env.soilClass) s.push('environmental');
    if ((fields.compareFields || []).length) s.push('compare');
    return s;
  }

  // ── Contract core: core(typedInput) -> { facts, provenance } ─────────────────
  function core(input) {
    input = input || {};
    var cohort = input.cohort || {};
    var features = cohort.features || [];
    var fields = input.fields || {};
    var avail = supported(fields);
    var want = (input.aggregators && input.aggregators.length)
      ? input.aggregators.filter(function (a) { return avail.indexOf(a) >= 0; })
      : avail;

    var facts = {
      cohort: {
        selector: cohort.selector || null,
        count: features.length,
        featureIds: features.map(function (f) { return f && f.id != null ? f.id : null; }),
      },
      aggregators: want,
    };
    if (want.indexOf('composition') >= 0) facts.composition = composition(features, fields);
    if (want.indexOf('value-stats') >= 0) facts.valueStats = valueStats(features, fields);
    if (want.indexOf('value-change') >= 0) facts.valueChange = valueChange(features, fields);
    if (want.indexOf('ownership') >= 0) facts.ownership = ownership(features, fields);
    if (want.indexOf('area-distribution') >= 0) facts.areaDistribution = areaDistribution(features, fields, input.areaEdges);
    if (want.indexOf('environmental') >= 0) facts.environmental = environmental(features, fields);
    if (want.indexOf('compare') >= 0) facts.compare = compare(features, fields);

    return { facts: facts, provenance: provenance(input, features.length) };
  }

  // Provenance (§6.4): an aggregate has no single citable document, so it is honestly
  // 'coarse' — the data lineage (the source + the cohort) with drill-down to the
  // contributing feature ids carried in facts.cohort.
  function provenance(input, count) {
    var sel = (input.cohort && input.cohort.selector) || {};
    return [{
      source_id: input.source_id || 'source',
      anchor: sel.label || sel.type || 'cohort',
      span: count + (count === 1 ? ' feature' : ' features'),
      state: 'coarse',
    }];
  }

  return {
    core: core,
    // exported helpers (unit-tested directly)
    stats: stats, composition: composition, valueStats: valueStats,
    valueChange: valueChange, ownership: ownership, areaDistribution: areaDistribution,
    environmental: environmental, compare: compare, supported: supported,
  };
}));
