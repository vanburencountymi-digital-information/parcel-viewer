/* Administrative tools menu — Help / Feedback / Data Request / About.
 *
 * A topbar button opens a dropdown of administrative tools. Each tool opens a
 * lightweight in-app modal: Help and About are read-only info windows; Feedback
 * and Data Request are forms. Form submission is a PLACEHOLDER for now — it shows
 * a thank-you state but does not POST anywhere yet (no backend endpoint wired).
 *
 * To later route a tool to a real page instead of a modal, give its config a
 * `url` and the handler will window.open() it instead of building a modal.
 */
(function () {
  "use strict";

  var btn  = document.getElementById("pv-admin-btn");
  var menu = document.getElementById("pv-admin-menu");
  if (!btn || !menu) return;

  // ── Dropdown open/close ────────────────────────────────────────────────────
  function openMenu() {
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onMenuKey);
  }
  function closeMenu() {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onMenuKey);
  }
  function toggleMenu() { menu.hidden ? openMenu() : closeMenu(); }

  function onDocClick(e) {
    if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeMenu();
  }
  function onMenuKey(e) { if (e.key === "Escape") { closeMenu(); btn.focus(); } }

  btn.addEventListener("click", function (e) { e.stopPropagation(); toggleMenu(); });

  menu.addEventListener("click", function (e) {
    var item = e.target.closest(".pv-admin-item");
    if (!item) return;
    closeMenu();
    openTool(item.getAttribute("data-tool"));
  });

  // ── Modal builder ───────────────────────────────────────────────────────────
  var _modal = null;
  var _modalReturnFocus = null;   // element to restore focus to on close (DIC-373)

  function getModalFocusables() {
    if (!_modal) return [];
    var sel = 'a[href], button:not([disabled]), input:not([disabled]), ' +
              'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.slice.call(_modal.querySelectorAll(sel))
      .filter(function (el) { return el.offsetParent !== null || el === document.activeElement; });
  }

  function closeModal() {
    if (!_modal) return;
    document.removeEventListener("keydown", onModalKey);
    _modal.remove();
    _modal = null;
    // Un-hide the rest of the page.
    var app = document.getElementById("app");
    if (app) { app.removeAttribute("inert"); app.removeAttribute("aria-hidden"); }
    // Restore focus to whatever opened the modal; if that trigger is now hidden
    // (e.g. an admin-menu item that closed with the menu), fall back to the
    // tools button so focus never lands on <body>.
    var ret = _modalReturnFocus;
    _modalReturnFocus = null;
    if (ret && document.contains(ret) && ret.offsetParent !== null) {
      ret.focus();
    } else {
      var ab = document.getElementById("pv-admin-btn");
      if (ab) ab.focus();
    }
  }

  function onModalKey(e) {
    if (e.key === "Escape") { closeModal(); return; }
    if (e.key !== "Tab" || !_modal) return;
    // Trap focus inside the dialog.
    var f = getModalFocusables();
    if (!f.length) { e.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1], active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !_modal.contains(active)) { e.preventDefault(); last.focus(); }
    } else {
      if (active === last || !_modal.contains(active)) { e.preventDefault(); first.focus(); }
    }
  }

  function openModal(title, bodyHtml, onMount, opts) {
    opts = opts || {};
    closeModal();
    _modalReturnFocus = document.activeElement;   // restore here on close (DIC-373)
    var modalCls = "pv-modal" + (opts.wide ? " pv-modal--wide" : "");
    var bodyCls  = "pv-modal-body" + (opts.flush ? " pv-modal-body--flush" : "");
    var back = document.createElement("div");
    back.className = "pv-modal-backdrop";
    back.innerHTML =
      '<div class="' + modalCls + '" role="dialog" aria-modal="true" aria-label="' + escAttr(title) + '">' +
        '<div class="pv-modal-header">' +
          '<span class="pv-modal-title">' + esc(title) + '</span>' +
          '<button class="pv-modal-close" aria-label="Close">&#10005;</button>' +
        '</div>' +
        '<div class="' + bodyCls + '">' + bodyHtml + '</div>' +
      '</div>';

    // Backdrop click (outside the dialog) closes; clicks inside do not.
    back.addEventListener("click", function (e) { if (e.target === back) closeModal(); });
    back.querySelector(".pv-modal-close").addEventListener("click", closeModal);
    document.addEventListener("keydown", onModalKey);

    document.body.appendChild(back);
    _modal = back;
    // Make the rest of the page inert + hidden from AT while the dialog is open.
    var app = document.getElementById("app");
    if (app) { app.setAttribute("inert", ""); app.setAttribute("aria-hidden", "true"); }
    if (typeof onMount === "function") onMount(back.querySelector(".pv-modal-body"));
    // Focus the first interactive element in the dialog for keyboard users.
    var focusable = back.querySelector("input, textarea, select, button.pv-modal-close");
    if (focusable) focusable.focus();
  }

  // Parcel/map-tool buttons and the tax-description info icon live outside the
  // dropdown (Layers panel + parcel info panel), wired via event delegation.
  document.addEventListener("click", function (e) {
    var pt = e.target.closest(".pv-ptool");
    if (pt) { openParcelTool(pt.getAttribute("data-ptool")); return; }
    var ib = e.target.closest(".pv-info-btn");
    if (ib) openInfoWindow(ib.getAttribute("data-info"));
  });

  function openInfoWindow(kind) {
    switch (kind) {
      case "tax":    return openTaxInfo();
      case "assess": return openAssessInfo();
    }
  }

  // ── Tool content ──────────────────────────────────────────────────────────
  function openTool(tool) {
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
      case "streetview": return openStreetView();
    }
  }

  function openHelp() {
    openModal("Help", [
      '<p class="pv-modal-lead">Quick reference for using the Parcel Viewer. Full documentation is coming soon.</p>',
      helpItem("Find a parcel", "Use the search box (or the search icon on mobile) to look up a parcel by parcel number, owner name, or address."),
      helpItem("Inspect a parcel", "Click any parcel on the map to open the Parcel Info panel with assessment and geometry details."),
      helpItem("Overlays", "Open Map Controls to toggle regulatory overlays (wetlands, soils, flood, zoning). Click the map with an overlay on to query it."),
      helpItem("Drawing &amp; measure", "Map Controls includes drawing and measurement tools for annotating the map."),
      helpItem("MapBuddy A.I.", "Ask the assistant questions about the map, parcels, and overlays in plain language."),
      '<p class="pv-modal-note">Need more help? Use <strong>Feedback</strong> to reach the team.</p>'
    ].join(""));
  }

  function openWhatsNew() {
    openModal("What's New", [
      '<p class="pv-modal-lead">Recent updates and new functionality.</p>',
      changeEntry("June 13, 2026", [
        "New <strong>Tools</strong> menu in the top bar: Print, Share, Bookmark, Data Request, Report a data error, Help, What&rsquo;s New, About, and Settings.",
        "<strong>Generate Parcel Packet</strong> and <strong>Compare Parcels</strong> are now available from the parcel popup; <strong>Street View</strong> added to Map Controls.",
        "Tax Description info window with the usage disclaimer — a full AI-driven explainer is coming soon.",
        "Mobile UI overhaul: unified tab bar, split-screen MapBuddy A.I., and improved search."
      ]),
      changeEntry("June 12, 2026", [
        "<strong>Dark mode</strong> with a dark basemap (moon icon in the top bar).",
        "<strong>MapBuddy A.I.</strong> assistant for asking questions about the map and parcels."
      ]),
      placeholderTag("This list is curated for now; an automatic release feed is planned.")
    ].join(""));
  }

  function openAbout() {
    var cc = window.COUNTY || {};
    var countyName = cc.name || "Van Buren County";
    var place = countyName + (cc.state ? ", " + cc.state : "");
    openModal("About", [
      '<p class="pv-modal-lead"><strong>Parcel Viewer</strong> — ' + esc(place) + '</p>',
      '<div class="pv-about-grid">' +
        aboutRow("Version", "0.x (preview)") +
        aboutRow("Maintained by", "DICE Labs") +
        aboutRow("Basemap", "CARTO / OpenStreetMap contributors") +
        aboutRow("Parcel data", countyName + " GIS") +
      '</div>',
      '<p class="pv-modal-note">This is a preview build. Data shown is for informational purposes only and is not a legal record of survey. Placeholder content — final attributions and version to be confirmed.</p>'
    ].join(""));
  }

  // ── Map-action tools (placeholders) ─────────────────────────────────────────
  function openPrint() {
    openModal("Print", [
      '<p class="pv-modal-lead">Print or export the current map and parcel details.</p>',
      '<p>A full <strong>map + parcel data sheet PDF</strong> export is on the way. For now you can print the current browser view.</p>',
      '<div class="pv-form-actions">' +
        '<button type="button" class="pv-btn-ghost" data-close>Close</button>' +
        '<button type="button" class="pv-btn-primary" id="pv-print-now">Print current view</button>' +
      '</div>',
      placeholderTag("Full PDF export with a formatted parcel sheet is planned (DIC-42).")
    ].join(""), function (bodyEl) {
      bodyEl.addEventListener("click", function (e) {
        if (e.target.closest("[data-close]")) return closeModal();
        if (e.target.closest("#pv-print-now")) { closeModal(); window.print(); }
      });
    });
  }

  function openShare() {
    var url = window.location.href;
    openModal("Share", [
      '<p class="pv-modal-lead">Share a link to this view.</p>',
      '<div class="pv-copy-row">' +
        '<input class="pv-input" id="pv-share-url" type="text" readonly value="' + escAttr(url) + '">' +
        '<button type="button" class="pv-btn-primary" id="pv-share-copy">Copy</button>' +
      '</div>',
      placeholderTag("Links that capture the selected parcel, zoom, and active layers are planned (DIC-52). For now this copies the current page URL.")
    ].join(""), function (bodyEl) {
      var copyBtn = bodyEl.querySelector("#pv-share-copy");
      copyBtn.addEventListener("click", function () {
        var input = bodyEl.querySelector("#pv-share-url");
        input.select();
        var done = function () { copyBtn.textContent = "Copied!"; setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(input.value).then(done, function () { try { document.execCommand("copy"); } catch (_) {} done(); });
        } else { try { document.execCommand("copy"); } catch (_) {} done(); }
      });
    });
  }

  function openBookmark() {
    openModal("Bookmarks", [
      '<p class="pv-modal-lead">Save parcels to revisit them quickly.</p>',
      '<p>Bookmarking will let you star a parcel from its info panel and keep a personal list on this device.</p>',
      placeholderTag("Coming soon.")
    ].join(""));
  }

  function openReportError() {
    var pin = currentParcelPin();
    var body =
      '<p class="pv-modal-lead">Spotted incorrect parcel data? Tell us what looks wrong.</p>' +
      '<form class="pv-form" novalidate>' +
        field("Parcel number" + (pin ? "" : ' <span class="pv-field-opt">(if known)</span>'),
          '<input type="text" name="pin" class="pv-input" placeholder="00-00-000-000-00" value="' + escAttr(pin || "") + '">') +
        field("What&rsquo;s incorrect?",
          '<textarea name="details" class="pv-input" rows="4" required placeholder="Describe the error — wrong owner, boundary, address, zoning…"></textarea>') +
        field("Email <span class=\"pv-field-opt\">(optional, for follow-up)</span>",
          '<input type="email" name="email" class="pv-input" placeholder="you@example.com">') +
        '<div class="pv-form-actions">' +
          '<button type="button" class="pv-btn-ghost" data-close>Cancel</button>' +
          '<button type="submit" class="pv-btn-primary">Send report</button>' +
        '</div>' +
      '</form>';
    openModal("Report a data error", body, wireForm("Report received!", "Thanks for helping keep the data accurate. (Placeholder — not yet sent to a server.)"));
  }

  function openSettings() {
    openModal("Settings", [
      '<p class="pv-modal-lead">Display preferences for this device.</p>',
      '<div class="pv-form">' +
        field("Area units",       '<select class="pv-input" disabled><option>Acres</option><option>Square feet</option></select>') +
        field("Coordinate format",'<select class="pv-input" disabled><option>Latitude / Longitude</option><option>State Plane (Michigan South)</option></select>') +
        field("Default basemap",  '<select class="pv-input" disabled><option>Light</option><option>Dark</option><option>Aerial</option></select>') +
      '</div>',
      placeholderTag("Settings are previews and not yet active. Dark mode is available now via the moon icon in the top bar.")
    ].join(""));
  }

  // ── Parcel tools (placeholders, surfaced in the Layers panel) ────────────────
  function openPacket() {
    openModal("Generate Parcel Packet", [
      '<p class="pv-modal-lead">A comprehensive, professionally formatted report for a parcel.</p>',
      '<p>The packet compiles assessment data, environmental conditions, spatial analysis, proximity metrics, and historical aerial imagery into a single document.</p>',
      placeholderTag("Flagship feature in development (DIC-340 / DIC-330).")
    ].join(""));
  }
  function openCompare() {
    openModal("Compare Parcels", [
      '<p class="pv-modal-lead">Side-by-side comparison of 2–5 parcels.</p>',
      '<p>Compare assessment, size, zoning, and environmental attributes — useful for appeals, neighbor comparisons, and due diligence.</p>',
      placeholderTag("Coming soon (DIC-54 / DIC-366).")
    ].join(""));
  }
  function openStreetView() {
    openModal("Street View", [
      '<p class="pv-modal-lead">Street-level imagery for the selected parcel.</p>',
      '<p>Open Google Street View or Mapillary at the parcel location for desk reviews and orientation.</p>',
      placeholderTag("Coming soon (DIC-55).")
    ].join(""));
  }

  // Tax description info — for now the disclaimer + a teaser for the full
  // explainer (DIC-369). This window becomes the AI-driven explainer later.
  function openTaxInfo() {
    openModal("About the Tax Description", [
      '<p class="pv-modal-lead">What the Tax Description is — and isn&rsquo;t.</p>',
      '<p>The Tax Description is an <strong>abbreviated</strong> version of the deeded legal description, used for <strong>taxation purposes only</strong>. It should never be used on deeds, titles, mortgages, or other legal documents. Always refer to the recorded deed for the full legal description.</p>',
      '<div class="pv-teaser">' +
        '<div class="pv-teaser-title"><span class="pv-badge">Coming soon</span> Tax Description Explainer</div>' +
        '<p class="pv-teaser-body">Soon this window will break down every part of this parcel&rsquo;s tax description in plain language — defining each term, explaining how it differs from a legal description, and (where the description supports it) highlighting each call on the map.</p>' +
      '</div>'
    ].join(""));
  }

  // Assessment info — for now an educational overview + a teaser for the full
  // AI/database-backed explainer (DIC-370). Becomes a callable module later.
  function openAssessInfo() {
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

  // Best-effort read of the currently selected parcel's PIN (for Report a data error).
  function currentParcelPin() {
    try {
      if (window.PS_SELECTED_PIN) return window.PS_SELECTED_PIN;
      if (window.PS_CURRENT_PARCEL && window.PS_CURRENT_PARCEL.pin) return window.PS_CURRENT_PARCEL.pin;
    } catch (_) {}
    return "";
  }

  var DATA_REQUEST_FORM_URL = (window.COUNTY && COUNTY.forms && COUNTY.forms.dataRequest) ||
    "https://form.jotform.com/261544522974159";

  function openDataRequest() {
    // Embed the JotForm directly in a modal window. If the iframe is blocked
    // (network/CSP/extension), the footer link opens the form in a new tab.
    var body =
      '<div class="pv-embed">' +
        '<iframe class="pv-embed-frame" src="' + DATA_REQUEST_FORM_URL + '" ' +
          'title="Data Request form" ' +
          'allow="geolocation; microphone; camera; fullscreen; payment" ' +
          'allowtransparency="true"></iframe>' +
        '<div class="pv-embed-foot">Form not loading? ' +
          '<a href="' + DATA_REQUEST_FORM_URL + '" target="_blank" rel="noopener">Open it in a new tab &#8599;</a>' +
        '</div>' +
      '</div>';
    openModal("Data Request", body, null, { wide: true, flush: true });
  }

  // ── Form helpers ────────────────────────────────────────────────────────────
  function wireForm(successTitle, successMsg) {
    return function (bodyEl) {
      var form = bodyEl.querySelector("form");
      if (!form) return;
      bodyEl.addEventListener("click", function (e) {
        if (e.target.closest("[data-close]")) closeModal();
      });
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (!form.checkValidity()) { form.reportValidity(); return; }
        // PLACEHOLDER: no backend yet. Log the payload and show a success state.
        var data = {};
        Array.prototype.forEach.call(form.elements, function (el) {
          if (el.name) data[el.name] = el.value;
        });
        console.info("[admin-menu] form submitted (placeholder, not sent):", data);
        bodyEl.innerHTML =
          '<div class="pv-form-success">' +
            '<div class="pv-form-success-icon">&#10003;</div>' +
            '<div class="pv-form-success-title">' + successTitle + '</div>' +
            '<p class="pv-form-success-msg">' + successMsg + '</p>' +
            '<button type="button" class="pv-btn-primary" data-close>Close</button>' +
          '</div>';
        bodyEl.querySelector("[data-close]").addEventListener("click", closeModal);
      });
    };
  }

  // ── Small HTML helpers ────────────────────────────────────────────────────
  function field(label, control) {
    return '<label class="pv-field"><span class="pv-field-label">' + label + '</span>' + control + '</label>';
  }
  function helpItem(h, p) {
    return '<div class="pv-help-item"><div class="pv-help-h">' + h + '</div><div class="pv-help-p">' + p + '</div></div>';
  }
  function aboutRow(k, v) {
    return '<div class="pv-about-k">' + esc(k) + '</div><div class="pv-about-v">' + esc(v) + '</div>';
  }
  function placeholderTag(text) {
    return '<p class="pv-modal-note"><span class="pv-badge">Preview</span> ' + text + '</p>';
  }
  function changeEntry(date, items) {
    return '<div class="pv-change"><div class="pv-change-date">' + esc(date) + '</div>' +
      '<ul class="pv-change-list">' + items.map(function (i) { return '<li>' + i + '</li>'; }).join("") + '</ul></div>';
  }
  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; });
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }
}());
