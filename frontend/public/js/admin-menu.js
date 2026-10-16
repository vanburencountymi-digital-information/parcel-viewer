/* The viewer's tools and windows: PV_TOOLS, bookmarks, the device display preferences
 * (accessibility, colour scheme, panel glass), and the windows not yet moved to Vue.
 *
 * The Help & tools dropdown (a Vue island, frontend/src/admin-menu/) opens these tools
 * through PV_TOOLS; each opens in the viewer's modal (frontend/src/modal/). Help, What's New,
 * About, Share, Bookmarks, Settings, Print, Street View, the two forms and the Parcel
 * Packet are Vue components (frontend/src/windows/, DIC-2389); the tax and assessment
 * info windows are still built here (with pv-explain.js).
 */
(function () {
  "use strict";

  function countyConfig() {
    return (window.PS_CONTEXT && window.PS_CONTEXT.config) || window.COUNTY || {};
  }

  // ── The menu and the modal ─────────────────────────────────────────────────
  // The Help & tools dropdown and the modal dialog are Vue islands (frontend/src/admin-menu/,
  // frontend/src/modal/, DIC-2389): the dropdown opens windows through PV_TOOLS below, and
  // openModal/closeModal hand the windows built here to the modal (PV_MODAL). Same contract
  // as before: openModal(title, bodyHtml, onMount(bodyEl), { wide, flush }), with onMount
  // running once the body is on the page.
  function openModal(title, bodyHtml, onMount, opts) {
    if (window.PV_MODAL) window.PV_MODAL.open(title, bodyHtml, onMount, opts);
  }
  function closeModal() {
    if (window.PV_MODAL) window.PV_MODAL.close();
  }

  // Parcel/map-tool buttons and the tax-description info icon live outside the
  // dropdown (Layers panel + parcel info panel), wired via event delegation.
  document.addEventListener("click", function (e) {
    var bm = e.target.closest("[data-bm-toggle]");
    if (bm) {
      var pc = window.PS_STATE && window.PS_STATE.parcel;
      if (pc) setBmButtonState(bm, bmToggle(pc));
      return;
    }
    var pt = e.target.closest(".pv-ptool");
    if (pt) { openParcelTool(pt.getAttribute("data-ptool")); return; }
    var ib = e.target.closest(".pv-info-btn");
    if (ib) openInfoWindow(ib.getAttribute("data-info"));
  });

  // ── Bookmarks (device-local, localStorage) ──────────────────────────────────
  var BM_KEY = "pv-bookmarks";
  function bmList() {
    try { var v = JSON.parse(localStorage.getItem(BM_KEY) || "[]"); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
  }
  function bmSave(list) { try { localStorage.setItem(BM_KEY, JSON.stringify(list)); } catch (_) {} }
  function bmHas(id) { return id != null && bmList().some(function (b) { return String(b.id) === String(id); }); }
  function bmAdd(p) {
    if (!p || p.id == null || bmHas(p.id)) return;
    var list = bmList();
    list.push({ id: p.id, pin: p.pin || "", owner: p.owner_name || "", address: p.site_address || "", muni: p.municipality || "" });
    bmSave(list);
  }
  function bmRemove(id) { bmSave(bmList().filter(function (b) { return String(b.id) !== String(id); })); }
  function bmToggle(p) { if (!p || p.id == null) return false; if (bmHas(p.id)) { bmRemove(p.id); return false; } bmAdd(p); return true; }
  function setBmButtonState(btn, on) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? "Remove bookmark" : "Bookmark this parcel";
    btn.classList.toggle("is-on", on);
    var label = btn.querySelector(".pv-bm-label");
    if (label) label.textContent = on ? "Bookmarked" : "Bookmark";
  }
  // Exposed so the parcel popup (map.js) can render + reflect the star state.
  window.PV_BOOKMARKS = { list: bmList, has: bmHas, add: bmAdd, remove: bmRemove, toggle: bmToggle };

  function openInfoWindow(kind) {
    switch (kind) {
      case "tax":    return openTaxInfo();
      case "assess": return openAssessInfo();
    }
  }

  // ── Tool content ──────────────────────────────────────────────────────────
  function openTool(tool) {
    // Capability gating (Phase 2): print/share are manifest capabilities. Skip even
    // programmatic opens when gated off (the menu item is hidden by pv-capabilities.js;
    // this also covers PV_TOOLS callers). Default-on when PV_CAPS is absent.
    if (window.PV_CAPS && (tool === "print" || tool === "share") && !window.PV_CAPS.isEnabled(tool)) return;
    switch (tool) {
      case "print":        return openPrint();
      case "share":        return openShare();
      case "bookmark":     return openBookmark();
      case "data-request": return openDataRequest();
      case "report-error": return openReportError();
      case "help":         return openHelp();
      case "whats-new":    return openWhatsNew();
      case "about":        return openAbout();
      case "settings":     return openSettings();
    }
  }

  function openParcelTool(tool) {
    switch (tool) {
      case "packet":     return openPacket();
      case "compare":    return openCompare();
      case "profile":    return openProfile();
      case "streetview": return openStreetView();
    }
  }

  // Neighborhood / Area Profile (DIC-588): the cohort-analyze profile preset (pv-profile.js).
  function openProfile() {
    if (window.PV_PROFILE && window.PV_PROFILE.open) { window.PV_PROFILE.open(); return; }
    openModal("Neighborhood Profile", placeholderTag("Profile is unavailable right now."));
  }

  // Programmatic access to the viewer's tools/windows (used by MapBuddy AI and
  // any other caller). Names match the data-ptool / data-info / menu ids. Each
  // opener handles the "select a parcel first" case on its own.
  var _PARCEL_TOOLS = { packet: 1, compare: 1, profile: 1, streetview: 1 };
  var _INFO_WINDOWS = { tax: 1, assess: 1 };
  var _MENU_TOOLS = { print: 1, share: 1, bookmark: 1, "data-request": 1,
    "report-error": 1, help: 1, "whats-new": 1, about: 1, settings: 1 };
  window.PV_TOOLS = {
    open: function (name) {
      if (_PARCEL_TOOLS[name]) return openParcelTool(name);
      if (_INFO_WINDOWS[name]) return openInfoWindow(name);
      if (_MENU_TOOLS[name])   return openTool(name);
      console.warn("[PV_TOOLS] unknown tool:", name);
    },
    list: function () {
      return Object.keys(_PARCEL_TOOLS).concat(Object.keys(_INFO_WINDOWS), Object.keys(_MENU_TOOLS));
    },
  };

  // Help, What's New, About, Settings, Print, Street View and the Data Request and Report
  // Error forms are Vue components (frontend/src/windows/, DIC-2389).
  function openVueWindow(name) {
    if (window.PV_WINDOWS) window.PV_WINDOWS.open(name);
  }
  function openHelp() { openVueWindow("help"); }
  function openWhatsNew() { openVueWindow("whats-new"); }
  function openAbout() { openVueWindow("about"); }
  function openSettings() { openVueWindow("settings"); }
  function openReportError() { openVueWindow("report-error"); }
  function openDataRequest() { openVueWindow("data-request"); }

  function openPrint() { openVueWindow("print"); }

  // Share and Bookmarks are Vue components too (frontend/src/windows/).
  function openShare() { openVueWindow("share"); }
  function openBookmark() { openVueWindow("bookmark"); }

  // ── Accessibility preferences (DIC-421 / DIC-376) ────────────────────────────
  // Device-local prefs applied as <html> classes; OS-seeded on first run.
  var A11Y = (function () {
    var CLS = { large: "pv-a11y-large", contrast: "pv-a11y-contrast", solid: "pv-a11y-solid", font: "pv-a11y-font", motion: "pv-a11y-motion" };
    function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
    function getFlag(n) { return lsGet("pv-a11y-" + n) === "1"; }
    function setFlag(n, on) { lsSet("pv-a11y-" + n, on ? "1" : "0"); document.documentElement.classList.toggle(CLS[n], !!on); }
    // Clamp to a sane range: Map Buddy can set this from model output, and it persists
    // (DIC-1870). The Settings menu offers 1 / 1.15 / 1.3.
    function clampTs(v) { v = parseFloat(v); return (v && v > 0) ? Math.min(1.5, Math.max(1, v)) : 1; }
    function getTs() { return clampTs(lsGet("pv-a11y-ts")); }
    function setTs(v) { v = clampTs(v); lsSet("pv-a11y-ts", String(v)); document.documentElement.style.setProperty("--pv-ts", v); document.documentElement.classList.toggle(CLS.large, v > 1); }
    function applyAll() { ["contrast", "solid", "font", "motion"].forEach(function (n) { document.documentElement.classList.toggle(CLS[n], getFlag(n)); }); setTs(getTs()); }
    function init() {
      try {
        if (lsGet("pv-a11y-seeded") !== "1") {
          if (matchMedia("(prefers-reduced-motion: reduce)").matches) lsSet("pv-a11y-motion", "1");
          if (matchMedia("(prefers-contrast: more)").matches) lsSet("pv-a11y-contrast", "1");
          if (matchMedia("(prefers-reduced-transparency: reduce)").matches) lsSet("pv-a11y-solid", "1");
          lsSet("pv-a11y-seeded", "1");
        }
      } catch (_) {}
      applyAll();
    }
    return { getFlag: getFlag, setFlag: setFlag, getTs: getTs, setTs: setTs, init: init };
  })();
  A11Y.init();
  applyGlassPref();
  // Device-local panel-glass transparency (a design pref, adjustable in Settings).
  function applyGlassPref() {
    try { var v = parseFloat(localStorage.getItem("pv-glass-alpha")); if (v > 0) document.documentElement.style.setProperty("--glass-alpha", v); } catch (_) {}
  }

  // Device-local color scheme (accent palette), applied as <html data-scheme>.
  // "terracotta" is the default (no attribute → :root tokens). See style.css.
  var PV_SCHEMES = ["terracotta", "forest", "ocean", "slate", "plum", "crimson"];
  // The county's configured default (COUNTY.styling.colorScheme, DIC-460), used
  // when the user hasn't picked a scheme; falls back to terracotta.
  function _countyScheme() {
    try {
      // Phase 1: prefer the assembled theme manifest's styling block (carried via the
      // assembler passthrough), falling back to COUNTY.styling. Additive — same default.
      var m = window.PS_MANIFEST;
      var styling = (m && typeof m === "object" && m.styling) || countyConfig().styling || {};
      var c = styling.colorScheme;
      return PV_SCHEMES.indexOf(c) !== -1 ? c : "terracotta";
    } catch (_) { return "terracotta"; }
  }
  function getScheme() {
    try { var s = localStorage.getItem("pv-color-scheme"); return PV_SCHEMES.indexOf(s) !== -1 ? s : _countyScheme(); }
    catch (_) { return _countyScheme(); }
  }
  function applyScheme(s) {
    if (s && s !== "terracotta") document.documentElement.setAttribute("data-scheme", s);
    else document.documentElement.removeAttribute("data-scheme");
  }
  function setScheme(s) {
    if (PV_SCHEMES.indexOf(s) === -1) s = "terracotta";
    try { localStorage.setItem("pv-color-scheme", s); } catch (_) {}
    applyScheme(s);
    // Re-tint the MAP too, not just the GUI chrome (DIC-505). map.js listens and
    // re-reads the scheme's --map-* accent tokens via applyTheme.
    try { window.dispatchEvent(new Event("pv-scheme-change")); } catch (_) {}
  }
  // Programmatic control (Settings UI, and available to MapBuddy AI later).
  window.PV_SCHEME = { get: getScheme, set: setScheme, list: PV_SCHEMES.slice() };
  // Only now: PV_SCHEMES is a var, undefined until the line above it runs. Applied before
  // its declaration, getScheme() threw, every load fell back to terracotta, and neither a
  // saved scheme nor the county's default ever showed after a reload.
  applyScheme(getScheme());

  // Header button = one-tap "maximum accessibility" toggle; fine-tuning lives
  // in Settings. A toast points the user there.
  (function () {
    var b = document.getElementById("pv-a11y-btn");
    if (!b) return;
    syncA11yButton();
    b.addEventListener("click", function () {
      var on = !maxA11yOn();
      setMaxA11y(on);
      syncA11yButton();
      toast(on ? "Maximum accessibility on — fine-tune under Settings." : "Accessibility reset to default.");
    });
  })();

  function maxA11yOn() { return A11Y.getFlag("contrast") && A11Y.getFlag("solid") && A11Y.getFlag("font") && A11Y.getFlag("motion") && A11Y.getTs() > 1; }
  function setMaxA11y(on) { ["contrast", "solid", "font", "motion"].forEach(function (n) { A11Y.setFlag(n, on); }); A11Y.setTs(on ? 1.3 : 1); }
  function syncA11yButton() { var b = document.getElementById("pv-a11y-btn"); if (!b) return; var on = maxA11yOn(); b.classList.toggle("is-on", on); b.setAttribute("aria-pressed", String(on)); }

  // Accessibility + panel-glass control for the Settings window (frontend/src/windows/) and
  // Map Buddy. Every change re-syncs the header button.
  window.PV_A11Y = {
    getFlag: A11Y.getFlag, getTextScale: A11Y.getTs,
    setFlag: function (n, on) { A11Y.setFlag(n, on); syncA11yButton(); },
    setTextScale: function (v) { A11Y.setTs(v); syncA11yButton(); },
    setMax: function (on) { setMaxA11y(on); syncA11yButton(); },
  };
  window.PV_GLASS = {
    /** The saved panel opacity (0.4–1), or null for the stylesheet's default. */
    get: function () {
      try { var v = parseFloat(localStorage.getItem("pv-glass-alpha")); return v > 0 ? v : null; } catch (_) { return null; }
    },
    set: function (alpha) {
      var a = Math.max(0.4, Math.min(1, parseFloat(alpha) || 0.62));
      document.documentElement.style.setProperty("--glass-alpha", a);
      try { localStorage.setItem("pv-glass-alpha", String(a)); } catch (_) {}
      return a;
    },
  };

  function toast(msg) {
    var t = document.createElement("div");
    t.className = "pv-toast"; t.setAttribute("role", "status"); t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add("pv-toast--show"); });
    setTimeout(function () { t.classList.remove("pv-toast--show"); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320); }, 3400);
  }

  // ── Parcel tools (the parcel panel's buttons) ──────────────────────────────
  // The Parcel Packet is a Vue component (frontend/src/windows/packet/, DIC-2389).
  function openPacket() { openVueWindow("packet"); }

  // Compare (DIC-589) is now the cohort-analyze 'compare' preset (a Vue island in
  // frontend/src/compare/): the parcel-action button ADDS the current parcel to the compare tray; the tray's button
  // renders the side-by-side table. Delegate; fall back to a hint if the module is absent.
  function openCompare() {
    if (window.PV_COMPARE && window.PV_COMPARE.addCurrent) { window.PV_COMPARE.addCurrent(); return; }
    openModal("Compare Parcels", [
      '<p class="pv-modal-lead">Side-by-side comparison of 2–5 parcels.</p>',
      placeholderTag("Compare is unavailable right now.")
    ].join(""));
  }
  function openStreetView() { openVueWindow("streetview"); }

  // Tax description info — for now the disclaimer + a teaser for the full
  // explainer (DIC-369). This window becomes the AI-driven explainer later.
  // Tax Description info (DIC-369). Live per-parcel explainer when a parcel is
  // selected and the module is loaded; static overview otherwise.
  function openTaxInfo() {
    var parcel = window.PS_STATE && window.PS_STATE.parcel;
    if (window.PV_EXPLAIN && parcel && parcel.id != null) {
      return window.PV_EXPLAIN.openTaxDescription(parcel, { openModal: openModal, closeModal: closeModal });
    }
    return openTaxInfoStatic();
  }

  function openTaxInfoStatic() {
    openModal("About the Tax Description", [
      '<p class="pv-modal-lead">What the Tax Description is — and isn&rsquo;t.</p>',
      '<p>The Tax Description is an <strong>abbreviated</strong> version of the deeded legal description, used for <strong>taxation purposes only</strong>. It should never be used on deeds, titles, mortgages, or other legal documents. Always refer to the recorded deed for the full legal description.</p>',
      '<div class="pv-teaser">' +
        '<div class="pv-teaser-title"><span class="pv-badge">Coming soon</span> Tax Description Explainer</div>' +
        '<p class="pv-teaser-body">Soon this window will break down every part of this parcel&rsquo;s tax description in plain language — defining each term, explaining how it differs from a legal description, and (where the description supports it) highlighting each call on the map.</p>' +
      '</div>'
    ].join(""));
  }

  // Assessment info (DIC-370). When a parcel is selected and the explainer module
  // is loaded, open the live per-parcel AI Assessment Explainer; otherwise fall
  // back to the generic educational overview below.
  function openAssessInfo() {
    var parcel = window.PS_STATE && window.PS_STATE.parcel;
    if (window.PV_EXPLAIN && parcel && parcel.id != null) {
      return window.PV_EXPLAIN.openAssessment(parcel, { openModal: openModal, closeModal: closeModal });
    }
    return openAssessInfoStatic();
  }

  function openAssessInfoStatic() {
    openModal("About Property Assessment", [
      '<p class="pv-modal-lead">How your assessment works — and what your taxes pay for.</p>',
      helpItem("Assessed Value (AV)", "Set by the local assessor at 50% of a property&rsquo;s estimated True Cash Value (market value)."),
      helpItem("State Equalized Value (SEV)", "AV after county and state equalization confirm assessments sit at the 50% level uniformly across jurisdictions."),
      helpItem("Taxable Value (TV)", "The value you&rsquo;re actually taxed on. Under Michigan&rsquo;s Proposal A it rises each year by the lesser of inflation or 5% — until the property transfers, when it &ldquo;uncaps&rdquo; to the SEV."),
      helpItem("Assessing vs. equalization vs. appraisal", "Assessing values every parcel for taxation; equalization checks those values are uniform across units; an appraisal is an independent market-value opinion for a specific purpose (sale, financing)."),
      helpItem("Where taxes go", "Millage funds schools, county and township services, libraries, roads, and special assessments."),
      helpItem("Appeals", "Disagree with your assessment? Appeal to the March Board of Review, then the Michigan Tax Tribunal."),
      '<div class="pv-teaser">' +
        '<div class="pv-teaser-title"><span class="pv-badge">Coming soon</span> Assessment Explainer</div>' +
        '<p class="pv-teaser-body">Soon this window will pull this parcel&rsquo;s full assessment history and tax detail, cite the relevant Michigan statutes, and use AI to walk through exactly how these numbers were derived and what they fund.</p>' +
      '</div>'
    ].join(""));
  }

  // ── Small HTML helpers ────────────────────────────────────────────────────
  function helpItem(h, p) {
    return '<div class="pv-help-item"><div class="pv-help-h">' + h + '</div><div class="pv-help-p">' + p + '</div></div>';
  }
  function placeholderTag(text) {
    return '<p class="pv-modal-note"><span class="pv-badge">Preview</span> ' + text + '</p>';
  }
}());
