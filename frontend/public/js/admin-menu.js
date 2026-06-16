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

  // Make a dialog draggable by its header and resizable from a corner handle.
  // Desktop-only — on narrow screens the modal stays full-width/centered.
  function makeModalMovable(modalEl, headerEl) {
    if (!modalEl || !headerEl) return;
    if (!window.matchMedia("(min-width: 641px)").matches) return;
    var tx = 0, ty = 0, pinned = false;
    // Lift the size constraints to the modal's CURRENT rendered size — but only
    // once a drag/resize actually begins. Pinning up front ran before the body
    // content was mounted (Bookmarks builds its list in onMount; What's New
    // fetches its changelog async), so the modal locked to its tiny empty-state
    // height: content then overflowed and the first resize snapped from that
    // stale size. Pinning lazily lets the modal open at its natural content size
    // and makes resizing start from what's actually on screen.
    function pinSize() {
      if (pinned) return;
      modalEl.style.width = modalEl.offsetWidth + "px";
      modalEl.style.height = modalEl.offsetHeight + "px";
      modalEl.style.maxWidth = "none";
      modalEl.style.maxHeight = "none";
      pinned = true;
    }
    headerEl.classList.add("pv-modal-header--drag");
    headerEl.addEventListener("pointerdown", function (e) {
      if (e.target.closest("button")) return;          // let the close button work
      e.preventDefault();
      pinSize();
      var sx = e.clientX, sy = e.clientY, ox = tx, oy = ty;
      headerEl.setPointerCapture(e.pointerId);
      function mv(ev) { tx = ox + (ev.clientX - sx); ty = oy + (ev.clientY - sy); modalEl.style.transform = "translate(" + tx + "px," + ty + "px)"; }
      function up() { try { headerEl.releasePointerCapture(e.pointerId); } catch (x) {} headerEl.removeEventListener("pointermove", mv); headerEl.removeEventListener("pointerup", up); }
      headerEl.addEventListener("pointermove", mv);
      headerEl.addEventListener("pointerup", up);
    });
    // Resize handle (bottom-right).
    var rh = document.createElement("div");
    rh.className = "pv-modal-resize";
    rh.setAttribute("aria-hidden", "true");
    modalEl.appendChild(rh);
    rh.addEventListener("pointerdown", function (e) {
      e.preventDefault(); e.stopPropagation();
      pinSize();
      var sx = e.clientX, sy = e.clientY, sw = modalEl.offsetWidth, sh = modalEl.offsetHeight;
      rh.setPointerCapture(e.pointerId);
      function mv(ev) {
        modalEl.style.width  = Math.max(360, Math.min(window.innerWidth  - 40, sw + (ev.clientX - sx))) + "px";
        modalEl.style.height = Math.max(280, Math.min(window.innerHeight - 40, sh + (ev.clientY - sy))) + "px";
      }
      function up() { try { rh.releasePointerCapture(e.pointerId); } catch (x) {} rh.removeEventListener("pointermove", mv); rh.removeEventListener("pointerup", up); }
      rh.addEventListener("pointermove", mv);
      rh.addEventListener("pointerup", up);
    });
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
    makeModalMovable(back.querySelector(".pv-modal"), back.querySelector(".pv-modal-header"));
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

  // Programmatic access to the viewer's tools/windows (used by MapBuddy AI and
  // any other caller). Names match the data-ptool / data-info / menu ids. Each
  // opener handles the "select a parcel first" case on its own.
  var _PARCEL_TOOLS = { packet: 1, compare: 1, streetview: 1 };
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

  function openHelp() {
    openModal("Help", [
      '<p class="pv-modal-lead">Quick reference for using the Parcel Viewer. Full documentation is coming soon.</p>',
      helpItem("Find a parcel", "Use the search box (or the search icon on mobile) to look up a parcel by parcel number, owner name, or address."),
      helpItem("Inspect a parcel", "Click any parcel on the map to open the Parcel Info panel with assessment and geometry details."),
      helpItem("Overlays", "Open Map Controls to toggle regulatory overlays (wetlands, soils, flood, zoning). Click the map with an overlay on to query it."),
      helpItem("Drawing &amp; measure", "Map Controls includes drawing and measurement tools for annotating the map."),
      helpItem("MapBuddy A.I.", "Ask the assistant questions about the map, parcels, and overlays in plain language."),
      helpItem("Keyboard navigation",
        "Everything works without a mouse." +
        "<ul class=\"pv-kbd-list\">" +
          "<li><strong>Tab</strong> / <strong>Shift+Tab</strong> &mdash; move forward / back between controls. A &ldquo;Skip to map&rdquo; link is the first stop.</li>" +
          "<li><strong>Enter</strong> &mdash; activate a button or link, or open the highlighted search result.</li>" +
          "<li><strong>Space</strong> &mdash; check or uncheck a layer (or any checkbox); also presses a button.</li>" +
          "<li><strong>&uarr;</strong> / <strong>&darr;</strong> arrows &mdash; move through search results; also adjust sliders and dropdowns.</li>" +
          "<li><strong>Esc</strong> &mdash; close the search results, a panel, the tools menu, or a dialog.</li>" +
        "</ul>" +
        "<div class=\"pv-kbd-sub\">Moving the map</div>" +
        "Click the map once (or <strong>Tab</strong> to it), then:" +
        "<ul class=\"pv-kbd-list\">" +
          "<li><strong>Arrow keys</strong> &mdash; pan (scroll) the map.</li>" +
          "<li><strong>+</strong> / <strong>&minus;</strong> &mdash; zoom in / out.</li>" +
          "<li><strong>Shift</strong> + arrow keys &mdash; rotate and tilt the view.</li>" +
        "</ul>"),
      '<p class="pv-modal-note">Need more help? Use <strong>Feedback</strong> to reach the team.</p>'
    ].join(""));
  }

  // ── Changelog / version (source: frontend/public/changelog.json) ────────────
  // Single source of truth for the app version + the What's New feed. Interim
  // hand-curated; intended to be generated from Linear at build time.
  var _changelog = null;
  function loadChangelog(cb) {
    if (_changelog) { cb(_changelog); return; }
    fetch("/frontend/public/changelog.json", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (d) { _changelog = d; cb(d); })
      .catch(function () { cb(null); });
  }
  function appVersion(cb) { loadChangelog(function (d) { cb(d && d.version ? d.version : null); }); }

  function openWhatsNew() {
    openModal("What's New",
      '<p class="pv-modal-lead">Recent updates and new functionality.</p>' +
      '<div id="pv-changelog" class="pv-changelog">Loading…</div>',
      function (bodyEl) {
        loadChangelog(function (d) {
          var el = bodyEl.querySelector("#pv-changelog");
          if (!el) return;
          if (!d || !d.releases || !d.releases.length) {
            el.innerHTML = '<p class="pv-empty">Release notes are unavailable right now.</p>';
            return;
          }
          el.innerHTML = d.releases.map(function (rel) {
            var head = "v" + esc(rel.version) + (rel.date ? " &middot; " + esc(rel.date) : "");
            var items = (rel.items || []).map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("");
            return '<div class="pv-change"><div class="pv-change-date">' + head + "</div>" +
              '<ul class="pv-change-list">' + items + "</ul></div>";
          }).join("");
        });
      });
  }

  function openAbout() {
    var cc = window.COUNTY || {};
    var countyName = cc.name || "Van Buren County";
    var place = countyName + (cc.state ? ", " + cc.state : "");
    openModal("About", [
      '<p class="pv-modal-lead"><strong>Parcel Viewer</strong> — ' + esc(place) + '</p>',
      '<div class="pv-about-grid">' +
        '<div class="pv-about-k">Version</div><div class="pv-about-v" id="pv-app-version">… (preview)</div>' +
        aboutRow("Maintained by", "DICE Labs") +
        aboutRow("Basemap", "CARTO / OpenStreetMap contributors") +
        aboutRow("Parcel data", countyName + " GIS") +
      '</div>',
      '<p class="pv-modal-note">This is a preview build. Data shown is for informational purposes only and is not a legal record of survey.</p>'
    ].join(""), function (bodyEl) {
      appVersion(function (v) {
        var el = bodyEl.querySelector("#pv-app-version");
        if (el) el.textContent = (v || "0.x") + " (preview)";
      });
    });
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
      placeholderTag("Full PDF export with a formatted parcel sheet is planned.")
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
      placeholderTag("Links that capture the selected parcel, zoom, and active layers are planned. For now this copies the current page URL.")
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

  function bookmarkListHtml() {
    var list = bmList();
    if (!list.length) {
      return '<p class="pv-empty">No bookmarks yet. Open a parcel and use the <strong>★ Bookmark</strong> button on its panel — saved parcels appear here.</p>';
    }
    return '<ul class="pv-bm-list">' + list.map(function (b) {
      var sub = [b.owner, b.address || b.muni].filter(Boolean).join(" · ");
      return '<li class="pv-bm-item">' +
        '<button type="button" class="pv-bm-open" data-bm-open="' + escAttr(b.id) + '">' +
          '<span class="pv-bm-pin">' + esc(b.pin || String(b.id)) + '</span>' +
          (sub ? '<span class="pv-bm-sub">' + esc(sub) + '</span>' : '') +
        '</button>' +
        '<button type="button" class="pv-bm-del" data-bm-del="' + escAttr(b.id) + '" ' +
          'aria-label="Remove bookmark ' + escAttr(b.pin || String(b.id)) + '" title="Remove">&#10005;</button>' +
      '</li>';
    }).join("") + '</ul>';
  }

  function openBookmark() {
    var pc = window.PS_STATE && window.PS_STATE.parcel;
    function render(bodyEl) {
      var addBtn = "";
      if (pc && pc.id != null) {
        addBtn = bmHas(pc.id)
          ? '<p class="pv-modal-note">Current parcel (' + esc(pc.pin) + ') is bookmarked.</p>'
          : '<div class="pv-form-actions"><button type="button" class="pv-btn-primary" id="pv-bm-add">★ Bookmark current parcel (' + esc(pc.pin) + ')</button></div>';
      }
      bodyEl.innerHTML =
        '<p class="pv-modal-lead">Saved parcels, stored on this device.</p>' +
        bookmarkListHtml() + addBtn;
      var add = bodyEl.querySelector("#pv-bm-add");
      if (add) add.addEventListener("click", function () { bmAdd(pc); render(bodyEl); });
      Array.prototype.forEach.call(bodyEl.querySelectorAll("[data-bm-open]"), function (el) {
        el.addEventListener("click", function () {
          var id = el.getAttribute("data-bm-open");
          closeModal();
          if (window.PS_selectParcelById) window.PS_selectParcelById(id);
        });
      });
      Array.prototype.forEach.call(bodyEl.querySelectorAll("[data-bm-del]"), function (el) {
        el.addEventListener("click", function () { bmRemove(el.getAttribute("data-bm-del")); render(bodyEl); });
      });
    }
    openModal("Bookmarks", "", function (bodyEl) { render(bodyEl); });
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
    openModal("Report a data error", body,
      wireFormPost("/report-error", "Report received!", "Thanks for helping keep the data accurate — we&rsquo;ll review it."));
  }

  function openSettings() {
    var coordFmt  = (window.PV_COORDS && window.PV_COORDS.getFormat && window.PV_COORDS.getFormat()) || "dd";
    var areaUnits = (window.PV_PREFS && window.PV_PREFS.getAreaUnits && window.PV_PREFS.getAreaUnits()) || "acres";
    var basemap   = (window.PV_PREFS && window.PV_PREFS.getBasemap && window.PV_PREFS.getBasemap()) || "light";
    var glassPct  = 62; try { var _ga = parseFloat(localStorage.getItem("pv-glass-alpha")); if (_ga > 0) glassPct = Math.round(_ga * 100); } catch (_) {}
    var orbitOn   = !(window.PV_PREFS && window.PV_PREFS.getCinematicOrbit) || window.PV_PREFS.getCinematicOrbit();
    function opt(v, label, cur) { return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + label + '</option>'; }
    openModal("Settings", [
      '<p class="pv-modal-lead">Display preferences for this device.</p>',
      '<div class="pv-form">' +
        field("Area units",
          '<select class="pv-input" id="pv-set-area">' +
            opt("acres", "Acres", areaUnits) + opt("sqft", "Square feet", areaUnits) + '</select>') +
        field("Coordinate format",
          '<select class="pv-input" id="pv-set-coord">' +
            opt("dd", "Decimal degrees", coordFmt) + opt("dms", "Degrees / minutes / seconds", coordFmt) +
            opt("spc", "State Plane (Michigan South)", coordFmt) + '</select>') +
        field("Default basemap",
          '<select class="pv-input" id="pv-set-basemap">' +
            opt("light", "Light", basemap) + opt("dark", "Dark", basemap) + opt("aerial", "Aerial imagery", basemap) + '</select>') +
        field("Panel glass", '<input type="range" class="pv-range" id="pv-set-glass" min="40" max="100" step="2" value="' + glassPct + '" aria-label="Panel transparency, lower is more see-through"><span class="pv-range-hint">Lower = more see-through</span>') +
        field("Search arrival",
          '<label class="pv-a11y-row" style="margin:0"><input type="checkbox" id="pv-set-orbit"' + (orbitOn ? " checked" : "") + '>' +
          '<span><span class="pv-a11y-lbl">Spin around parcel</span>' +
          '<span class="pv-a11y-desc">After a search, orbit the parcel once. Turn off for a quick fly-in.</span></span></label>') +
      '</div>',
      '<p class="pv-settings-h">Accessibility</p>',
      a11yControlsHtml(),
      '<p class="pv-modal-note">Changes apply immediately and are saved on this device. The header button toggles all of these at once.</p>'
    ].join(""), function (bodyEl) {
      var a = bodyEl.querySelector("#pv-set-area");
      var c = bodyEl.querySelector("#pv-set-coord");
      var b = bodyEl.querySelector("#pv-set-basemap");
      if (a) a.addEventListener("change", function () { window.PV_PREFS && window.PV_PREFS.setAreaUnits(a.value); });
      if (c) c.addEventListener("change", function () { window.PV_COORDS && window.PV_COORDS.setFormat(c.value); });
      if (b) b.addEventListener("change", function () { window.PV_PREFS && window.PV_PREFS.setBasemap(b.value); });
      var orb = bodyEl.querySelector("#pv-set-orbit");
      if (orb) orb.addEventListener("change", function () { window.PV_PREFS && window.PV_PREFS.setCinematicOrbit && window.PV_PREFS.setCinematicOrbit(orb.checked); });
      var g = bodyEl.querySelector("#pv-set-glass");
      if (g) g.addEventListener("input", function () { var a = Math.max(0.4, Math.min(1, g.value / 100)); document.documentElement.style.setProperty("--glass-alpha", a); try { localStorage.setItem("pv-glass-alpha", String(a)); } catch (_) {} });
      wireA11yControls(bodyEl);
    });
  }

  // ── Accessibility preferences (DIC-421 / DIC-376) ────────────────────────────
  // Device-local prefs applied as <html> classes; OS-seeded on first run.
  var A11Y = (function () {
    var CLS = { large: "pv-a11y-large", contrast: "pv-a11y-contrast", solid: "pv-a11y-solid", font: "pv-a11y-font", motion: "pv-a11y-motion" };
    function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
    function getFlag(n) { return lsGet("pv-a11y-" + n) === "1"; }
    function setFlag(n, on) { lsSet("pv-a11y-" + n, on ? "1" : "0"); document.documentElement.classList.toggle(CLS[n], !!on); }
    function getTs() { var v = parseFloat(lsGet("pv-a11y-ts")); return (v && v > 0) ? v : 1; }
    function setTs(v) { v = parseFloat(v) || 1; lsSet("pv-a11y-ts", String(v)); document.documentElement.style.setProperty("--pv-ts", v); document.documentElement.classList.toggle(CLS.large, v > 1); }
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

  // Programmatic accessibility + panel-glass control (MapBuddy AI, etc.).
  window.PV_A11Y = {
    setFlag: A11Y.setFlag, getFlag: A11Y.getFlag,
    setTextScale: A11Y.setTs, getTextScale: A11Y.getTs,
    setMax: function (on) { setMaxA11y(on); syncA11yButton(); },
  };
  window.PV_GLASS = {
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

  // Accessibility controls, surfaced inside the Settings dialog.
  function a11yControlsHtml() {
    function chk(name, label, desc) {
      return '<label class="pv-a11y-row"><input type="checkbox" class="pv-a11y-chk" data-a="' + name + '"' + (A11Y.getFlag(name) ? " checked" : "") + '>' +
        '<span><span class="pv-a11y-lbl">' + esc(label) + '</span><span class="pv-a11y-desc">' + esc(desc) + '</span></span></label>';
    }
    var ts = A11Y.getTs();
    function tsOpt(v, l) { return '<option value="' + v + '"' + (Math.abs(ts - v) < 0.001 ? " selected" : "") + '>' + l + '</option>'; }
    return field("Text size", '<select class="pv-input" id="pv-a11y-ts">' + tsOpt(1, "Default") + tsOpt(1.15, "Large") + tsOpt(1.3, "Larger") + '</select>') +
      '<div class="pv-a11y-list">' +
        chk("contrast", "High contrast", "Darker text and stronger outlines.") +
        chk("solid", "Reduce transparency", "Make panels solid instead of glass.") +
        chk("font", "Legible font", "Switch to a high-legibility typeface (Atkinson Hyperlegible).") +
        chk("motion", "Reduce motion", "Turn off animations and transitions.") +
      '</div>' +
      field("Language", '<select class="pv-input" id="pv-a11y-lang"><option value="en" selected>English</option><option value="es" disabled>Español — coming soon</option></select>');
  }
  function wireA11yControls(bodyEl) {
    [].forEach.call(bodyEl.querySelectorAll(".pv-a11y-chk"), function (c) {
      c.addEventListener("change", function () { A11Y.setFlag(c.getAttribute("data-a"), c.checked); syncA11yButton(); });
    });
    var tsSel = bodyEl.querySelector("#pv-a11y-ts");
    if (tsSel) tsSel.addEventListener("change", function () { A11Y.setTs(tsSel.value); syncA11yButton(); });
  }

  // ── Parcel tools (placeholders, surfaced in the Layers panel) ────────────────
  function openPacket() {
    var pc = window.PS_STATE && window.PS_STATE.parcel;
    if (!pc) {
      openModal("Parcel Packet", '<p class="pv-modal-lead">Select a parcel first, then open its Packet.</p>');
      return;
    }
    var pin   = pc.pin || "—";
    var owner = pc.owner_name || "Owner on record";
    var addr  = pc.site_address || "Address on file";
    var muni  = pc.municipality || "Van Buren County";
    var acres = pc.acres != null ? pc.acres.toFixed(2) : "—";
    var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    var d = new Date();
    var dateStr = months[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();

    function chip(t)  { return '<span class="pp-chip">' + esc(t) + '</span>'; }
    function samp()   { return '<span class="pp-samp">sample</span>'; }
    function fact(l, v, s) { return '<div class="pp-fact"><div class="pp-fact-v">' + esc(v) + (s ? samp() : '') + '</div><div class="pp-fact-l">' + esc(l) + '</div></div>'; }
    function sec(t, inner) { return '<section class="pp-section"><h3 class="pp-section-h">' + esc(t) + '</h3>' + inner + '</section>'; }
    // Per-section Q&A bank powering the interactive "What this means" panels.
    // In production these answers stream live from the Knowledge Base; here a few
    // canned exchanges per section demonstrate the section-scoped chat experience.
    var PACKET_QA = {
      assess: { ph: "Ask about assessment, taxes, or exemptions…", qa: [
        { q: "Why is taxable value lower than assessed?", a: "Because of Michigan's Proposal A cap. Taxable Value can rise no more than 5% or the rate of inflation per year, even when market value climbs faster — so over time it drifts below the Assessed Value (about half of market). The gap here reflects years of capped growth. (Sample answer.)" },
        { q: "What would taxes be if I bought today?", a: "At sale the Taxable Value “uncaps” and resets up to the Assessed Value (~$131,100), so a new buyer's bill is figured on roughly that number instead of the current $73,663 — often a noticeable jump. The exact dollars depend on this district's millage rate. (Sample answer.)" } ] },
      owner: { ph: "Ask about ownership, deeds, or liens…", qa: [
        { q: "Are there any liens on the property?", a: "The recorded chain shows clean warranty-deed transfers with no liens or encumbrances in the index. The live Packet flags recorded mortgages, tax liens, and easements; a full title search confirms anything unrecorded. (Sample answer.)" },
        { q: "When did the current owner buy it?", a: "2014, by warranty deed — Liber 1444, Page 933. (Sample answer.)" } ] },
      env: { ph: "Ask about soils, septic, or flood risk…", qa: [
        { q: "Can I build a pole barn here?", a: "Physically, yes — the gentle 0–6% slope and well-drained Oshtemo sandy loam make an accessory building straightforward, with minimal grading. What actually governs it is zoning: Almena Township's accessory-structure rules set the maximum size, height, and setbacks. The live Packet reads this parcel's zoning district and quotes those limits. (Sample answer.)" },
        { q: "Is this a good septic site?", a: "Likely yes. Oshtemo sandy loam percolates quickly, which is what a conventional drain field needs, and the parcel sits outside mapped wetlands and floodplain. Final approval comes from a Van Buren County Health Department perc test. (Sample answer.)" },
        { q: "What's the flood risk?", a: "Low. No part of the parcel lies in a FEMA Special Flood Hazard Area, so flood insurance isn't federally required and floodplain building limits don't apply. The nearest mapped flood zone follows the river corridor, well off this parcel. (Sample answer.)" } ] },
      aerial: { ph: "Ask about the parcel's history…", qa: [
        { q: "When was the house built?", a: "Comparing frames, the home first appears between the 1968 and 1981 imagery — pointing to construction in the 1970s, consistent with the 1971 parcel split. Assessor records would confirm the exact year. (Sample answer.)" },
        { q: "Was this land ever farmed?", a: "The earliest frames show cleared, row-cropped fields; tree cover and the driveway appear in later decades as the parcel shifted to residential use. (Sample answer.)" } ] },
      docs: { ph: "Ask about documents or boundaries…", qa: [
        { q: "Where are the property corners?", a: "The County Surveyor's field notes for Section 1, T1S R13W record the monuments and measurements that fix the corners. The live Packet links the notes and can drop those corners onto the map. (Sample answer.)" } ] },
      taxdesc: { ph: "Ask about the legal description…", qa: [
        { q: "What does T1S R13W mean?", a: "Township 1 South, Range 13 West of the Michigan Meridian — a coordinate in the Public Land Survey grid. Townships are counted north/south from the baseline, ranges east/west from the meridian, so it pins the land to Almena Township's survey grid. (Sample answer.)" },
        { q: "Where is this in the section?", a: "In the NW¼ of the NW¼ — the northwesternmost 40 acres of Section 1. The parcel is a 200 × 509.6 ft rectangle tucked into that corner, about 2.34 acres. (Sample answer.)" },
        { q: "What does POB mean?", a: "“Point of Beginning” — the surveyed start of the boundary walk. A metes-and-bounds description leaves the POB, runs each bearing-and-distance call in turn, and must close back to it. (Sample answer.)" } ] },
      ledger: { ph: "Ask about any event…", qa: [
        { q: "What happened in 2014?", a: "Two linked events: the property sold to Smith, John & Jane by warranty deed (Liber 1444 Pg 933), and that sale uncapped the taxable value — resetting it from $73,663 toward assessed value and raising the bill. (Sample answer.)" },
        { q: "Why did the taxes jump?", a: "The 2014 sale uncapped the taxable value. Under Proposal A it stays capped while ownership is unchanged, then resets up to assessed value at transfer. (Sample answer.)" },
        { q: "When was the house built?", a: "Around 1968 — the dwelling first appears between the 1955 and 1968 aerials. It's marked inferred (hollow dot) since no recorded permit predates our digital records. (Sample answer.)" } ] }
    };
    // The interpretation layer — plain-language AI explanation, now interactive:
    // each panel carries suggested questions + an ask box scoped to its domain.
    function explain(key, html) {
      var cfg = PACKET_QA[key] || { ph: "Ask a question…", qa: [] };
      var chips = cfg.qa.map(function (x) { return '<button type="button" class="pp-qa-chip">' + esc(x.q) + '</button>'; }).join("");
      return '<div class="pp-explain" data-qa="' + escAttr(key) + '">' +
        '<div class="pp-explain-h"><span aria-hidden="true">✨</span> What this means</div>' +
        '<p>' + html + '</p>' +
        '<div class="pp-qa-thread" aria-live="polite"></div>' +
        (chips ? '<div class="pp-qa-chips">' + chips + '</div>' : '') +
        '<form class="pp-qa-form"><input type="text" class="pp-qa-input" autocomplete="off" ' +
          'aria-label="Ask a question about this section" placeholder="' + escAttr(cfg.ph) + '">' +
          '<button type="submit" class="pp-qa-send">Ask</button></form>' +
        '</div>';
    }

    var aiSummary =
      'This ' + esc(acres) + '-acre parcel in ' + esc(muni) + ', held by ' + esc(owner) +
      ', is located at ' + esc(addr) + '. Assessed and taxable values have trended steadily over the past ' +
      'five years, and a principal-residence exemption is on file. The property carries no FEMA flood designation ' +
      'and no mapped wetlands within 200&nbsp;ft; soils are well-drained sandy loam. Two parcels border it to the ' +
      'north and west. <em>(Illustrative — the live Packet writes this on demand from the Knowledge Base.)</em>';

    var aerials = ["1955","1968","1981","1998","2012","2025"].map(function (y) {
      return '<div class="pp-aerial"><div class="pp-aerial-img"></div><span>' + y + '</span></div>';
    }).join("");

    var legalDesc = "COM AT NW COR OF SEC 1, T1S R13W; TH S 89°34' E ALG N SEC LINE 200.0 FT; " +
      "TH S 00°12' W 509.6 FT; TH N 89°34' W 200.0 FT; TH N 00°12' E 509.6 FT TO POB. " +
      "PART OF NW 1/4 OF NW 1/4, SEC 1, T1S R13W, ALMENA TWP, VAN BUREN CO, MI. 2.34 AC M/L.";
    // Aliquot diagram: the section, its quarters, and the NW¼-of-NW¼ where the parcel sits.
    var aliquotSvg =
      '<svg class="pp-aliquot-svg" viewBox="0 0 200 206" role="img" ' +
        'aria-label="Section diagram: the parcel lies in the northwest quarter of the northwest quarter of Section 1">' +
      '<rect x="18" y="18" width="160" height="160" fill="var(--pp-aliquot-bg,#f5f3f0)" stroke="#9ca3af" stroke-width="1.5"/>' +
      '<rect x="18" y="18" width="80" height="80" fill="rgba(163,71,59,0.10)"/>' +
      '<rect x="18" y="18" width="40" height="40" fill="rgba(163,71,59,0.30)"/>' +
      '<g stroke="#cbd5e1" stroke-width="0.8"><line x1="58" y1="18" x2="58" y2="178"/>' +
        '<line x1="138" y1="18" x2="138" y2="178"/><line x1="18" y1="58" x2="178" y2="58"/>' +
        '<line x1="18" y1="138" x2="178" y2="138"/></g>' +
      '<g stroke="#6b7280" stroke-width="1.4"><line x1="98" y1="18" x2="98" y2="178"/>' +
        '<line x1="18" y1="98" x2="178" y2="98"/></g>' +
      '<rect x="21" y="21" width="6.1" height="15.4" fill="var(--ui-accent)" stroke="#fff" stroke-width="0.5"/>' +
      '<text x="186" y="14" font-size="11" font-weight="700" fill="currentColor">N</text>' +
      '<line x1="183" y1="23" x2="183" y2="9" stroke="currentColor" stroke-width="1.2"/>' +
      '<path d="M183 6 l-2.6 4.5 h5.2 z" fill="currentColor"/>' +
      '<text x="98" y="196" text-anchor="middle" font-size="9.5" fill="currentColor">Sec 1 · 640 ac · quarters &amp; quarter-quarters</text>' +
      '</svg>';

    // ── Parcel Ledger (the backbone) ──────────────────────────────────────
    // Heterogeneous event stream; the rest of the Packet is a view onto this.
    var LCATS = {
      ownership:  { label: "Ownership",  color: "#a3473b" },
      tax:        { label: "Tax",        color: "#b58d4a" },
      land:       { label: "Land",       color: "#4d7c4d" },
      survey:     { label: "Survey",     color: "#3b7a8a" },
      regulatory: { label: "Permit",     color: "#7a5ea3" },
      imagery:    { label: "Imagery",    color: "#8a8a8a" }
    };
    var LEDGER = [
      { y:1871, cat:"imagery",    rec:true,  t:"Section first platted",            d:"Section 1 appears in the 1873 county plat book with its original owner of record — the earliest documented snapshot of this land.", src:"Plat book 1873" },
      { y:1955, cat:"imagery",    rec:true,  t:"Aerial imagery captured",          d:"The earliest aerial frame shows the land in row-crop agriculture.", src:"Aerial 1955" },
      { y:1968, cat:"land",       rec:false, t:"Dwelling constructed",             d:"The home first appears between the 1955 and 1968 aerials, so the build date is inferred from imagery — not a recorded permit.", src:"Aerial 1968" },
      { y:1971, cat:"land",       rec:true,  t:"Parcel created from 40-acre split", d:"Carved from the NW¼ of the NW¼. A split creates a new PIN and legal description; records before this date describe the parent parcel.", src:"Split record" },
      { y:1994, cat:"survey",     rec:true,  t:"Boundary survey — corners monumented", d:"A licensed survey set physical monuments at the corners and recorded the measurements — the authoritative basis for the boundary on the ground.", src:"Surveyor field notes" },
      { y:2003, cat:"ownership",  rec:true,  t:"Conveyed to prior owner",          d:"Warranty deed — the strongest form of conveyance, guaranteeing clear title.", src:"Deed 2003" },
      { y:2008, cat:"tax",        rec:true,  t:"Drain assessment levied (Smith Drain)", d:"A charge by the County Drain Commissioner to fund an established drain serving this land; it rides on the tax bill until paid off.", src:"Assessment roll" },
      { y:2014, cat:"ownership",  rec:true,  t:"Conveyed to Smith, John & Jane",   d:"Warranty deed — Liber 1444, Page 933.", src:"Deed 2014" },
      { y:2014, cat:"tax",        rec:true,  t:"Taxable value uncapped at sale",   d:"The sale reset taxable value from the capped $73,663 toward assessed value, raising the next owner's tax bill.", src:"Assessment record" },
      { y:2016, cat:"regulatory", rec:true,  t:"Building permit — pole barn",      d:"An accessory structure was permitted, fixing its size, height, and setbacks under township zoning.", src:"Permit 2016" },
      { y:2025, cat:"imagery",    rec:true,  t:"Aerial imagery captured",          d:"The most recent aerial shows current site conditions.", src:"Aerial 2025" }
    ];
    var L_Y0 = 1871, L_Y1 = 2026;
    function lx(y) { return (16 + (y - L_Y0) / (L_Y1 - L_Y0) * 648).toFixed(1); }

    var ribbonTicks = LEDGER.map(function (e, i) {
      var x = lx(e.y), col = LCATS[e.cat].color;
      var dot = e.rec
        ? '<circle cx="' + x + '" cy="20" r="3.2" fill="' + col + '"/>'
        : '<circle cx="' + x + '" cy="20" r="3" fill="var(--pp-ribbon-bg,#fff)" stroke="' + col + '" stroke-width="1.4"/>';
      return '<g class="pp-ltick" data-li="' + i + '">' +
        '<line x1="' + x + '" y1="24" x2="' + x + '" y2="42" stroke="' + col + '" stroke-width="1.4"/>' + dot +
        '<rect x="' + (x - 7) + '" y="6" width="14" height="40" fill="transparent"/></g>';
    }).join("");
    var ribbon =
      '<svg class="pp-ribbon-svg" viewBox="0 0 680 70" role="img" aria-label="Timeline of recorded events for this parcel, 1871 to present">' +
      '<rect x="' + lx(1871) + '" y="46" width="' + (lx(1969) - lx(1871)).toFixed(1) + '" height="9" fill="rgba(77,124,77,0.12)"/>' +
      '<rect x="' + lx(1971) + '" y="46" width="' + (lx(2026) - lx(1971)).toFixed(1) + '" height="9" fill="rgba(163,71,59,0.10)"/>' +
      '<text x="' + lx(1915) + '" y="52.6" text-anchor="middle" font-size="7.5" fill="#6b7280">Agricultural</text>' +
      '<text x="' + lx(2000) + '" y="52.6" text-anchor="middle" font-size="7.5" fill="#6b7280">Residential</text>' +
      '<line x1="16" y1="42" x2="664" y2="42" stroke="#e5e7eb" stroke-width="1"/>' + ribbonTicks +
      [1900,1950,2000].map(function (yr) { return '<text x="' + lx(yr) + '" y="65" text-anchor="middle" font-size="8" fill="#9ca3af">' + yr + '</text>'; }).join("") +
      '</svg>';

    var lFilters = '<div class="pp-lfilters"><button type="button" class="pp-lchip" data-cat="all">All</button>' +
      Object.keys(LCATS).map(function (k) { return '<button type="button" class="pp-lchip" data-cat="' + k + '" style="--c:' + LCATS[k].color + '">' + esc(LCATS[k].label) + '</button>'; }).join("") + '</div>';
    var lLegend = '<div class="pp-llegend"><span class="pp-ldot" style="--c:#6b7280"></span>recorded' +
      '<span class="pp-ldot pp-ldot--inf" style="--c:#6b7280;margin-left:10px"></span>inferred from imagery</div>';
    var lOrder = LEDGER.map(function (e, i) { return i; }).sort(function (a, b) { return LEDGER[b].y - LEDGER[a].y; });
    var lRows = lOrder.map(function (i) {
      var e = LEDGER[i], col = LCATS[e.cat].color;
      return '<li class="pp-levent" data-li="' + i + '" data-cat="' + e.cat + '">' +
        '<button type="button" class="pp-levent-head" aria-expanded="false">' +
        '<span class="pp-ldot' + (e.rec ? '' : ' pp-ldot--inf') + '" style="--c:' + col + '"></span>' +
        '<span class="pp-lyear">' + e.y + '</span>' +
        '<span class="pp-lcat" style="color:' + col + '">' + esc(LCATS[e.cat].label) + '</span>' +
        '<span class="pp-ltitle">' + esc(e.t) + '</span></button>' +
        '<div class="pp-lexplain" hidden><p>' + esc(e.d) + '</p>' +
        '<a class="pp-lsrc" href="#" onclick="return false">' + esc(e.src) + ' ↗</a></div></li>';
    }).join("");
    var lInset = '<figure class="pp-linset"><div class="pp-linset-img"></div>' +
      '<figcaption class="pp-linset-cap">Select an event to see the parcel at that time. ' + samp() + '</figcaption></figure>';
    var ledgerInner =
      '<p class="pp-note">Every event the county has recorded for this parcel — the backbone the rest of the Packet explains. ' + samp() + '</p>' +
      '<div class="pp-ledger-ribbon">' + ribbon + '</div>' + lFilters + lLegend +
      '<div class="pp-lbody"><ul class="pp-llist">' + lRows + '</ul>' + lInset + '</div>' +
      explain('ledger', 'This is the parcel\'s complete event history — deeds, splits, surveys, assessments, permits, and imagery, newest first. <b>Solid dots</b> are recorded in an official document; <b>hollow dots</b> are inferred from aerial imagery and aren\'t authoritative. Expand any row for the plain-language story, click a point on the ribbon to jump to it, or ask about a moment below.');

    var html =
    '<div class="pp">' +
      '<div class="pp-hero">' +
        '<div class="pp-hero-row"><span class="pp-eyebrow">PARCEL PACKET</span>' +
          '<span class="pp-preview-badge">Sample preview</span></div>' +
        '<div class="pp-hero-addr">' + esc(addr) + '</div>' +
        '<div class="pp-hero-sub">' + esc(pin) + ' &middot; ' + esc(muni) + ' &middot; ' + esc(owner) + '</div>' +
        '<div class="pp-hero-meta">Comprehensive property intelligence &middot; generated ' + esc(dateStr) + '</div>' +
      '</div>' +

      '<div class="pp-formats"><span class="pp-formats-l">Available as</span>' +
        chip("Interactive") + chip("PDF") + chip("Audio") + chip("Video") + chip("AI Q&A session") +
        '<button type="button" class="pp-share-btn" id="pp-share-btn" aria-expanded="false">🔗 Share / Embed</button>' +
        '</div>' +

      '<div class="pp-body">' +

        '<div class="pp-share" id="pp-share" hidden>' +
          '<div class="pp-share-h"><span aria-hidden="true">🔗</span> Share this Packet <span class="pp-samp">paid add-on</span></div>' +
          '<p class="pp-share-sub">Title companies and agents can hand a client a live Packet or embed it on a listing. Sharing is a metered add-on — billed per share or by monthly plan, with API limits and co-branding.</p>' +
          '<label class="pp-share-field"><span class="pp-share-lbl">Shareable link</span>' +
            '<span class="pp-share-row"><input class="pp-share-in" readonly value="https://packet.dicelabs.org/p/' + escAttr(pin) + '?s=ab12cd"> ' +
            '<button type="button" class="pp-share-copy" data-copy="link">Copy</button></span></label>' +
          '<label class="pp-share-field"><span class="pp-share-lbl">Embed snippet</span>' +
            '<span class="pp-share-row"><textarea class="pp-share-in" readonly rows="2">&lt;iframe src="https://packet.dicelabs.org/embed/' + escAttr(pin) + '?k=YOUR_API_KEY" width="100%" height="640" style="border:0"&gt;&lt;/iframe&gt;</textarea> ' +
            '<button type="button" class="pp-share-copy" data-copy="embed">Copy</button></span></label>' +
          '<ul class="pp-share-terms">' +
            '<li><b>Per-share fee</b> or monthly embed plan ' + samp() + '</li>' +
            '<li><b>API rate limits</b> by tier — views/day &amp; allowed domains</li>' +
            '<li><b>Co-branding</b> — your logo alongside “Powered by DICE Labs”</li>' +
            '<li><b>Client view</b> hides internal/admin-only fields</li>' +
          '</ul>' +
        '</div>' +

        '<div class="pp-ai"><div class="pp-ai-h"><span aria-hidden="true">✨</span> A.I. Summary</div>' +
          '<p class="pp-ai-text">' + aiSummary + '</p></div>' +

        '<div class="pp-facts">' +
          fact("Acreage", acres + " ac", false) +
          fact("Class", "401 — Residential", true) +
          fact("Assessed Value", "$131,100", true) +
          fact("Taxable Value", "$73,663", true) +
          fact("PRE", "100%", true) +
          fact("School", "Gobles Public", true) + '</div>' +

        sec("Parcel Ledger", ledgerInner) +

        sec("Assessment & Tax",
          '<table class="pp-table"><thead><tr><th></th><th>Current</th><th>Prior</th></tr></thead><tbody>' +
          '<tr><td>Assessed Value</td><td>$131,100</td><td>$124,800</td></tr>' +
          '<tr><td>Taxable Value</td><td>$73,663</td><td>$71,940</td></tr>' +
          '<tr><td>Est. Market Value</td><td>$262,200</td><td>$249,600</td></tr>' +
          '</tbody></table><p class="pp-note">Includes a 5-year assessed-value history. ' + samp() + '</p>' +
          explain('assess', 'In Michigan the <b>Assessed Value</b> is set at about half of market value, while the <b>Taxable Value</b> — the figure your bill is actually calculated on — can rise no faster than inflation or 5% a year under Proposal A. That cap is why the taxable value sits well below the assessed value here, and why a long-time owner often pays less than a recent buyer would on an identical home. The <b>100% Principal Residence Exemption</b> confirms this is the owner\'s primary home, exempting it from the 18-mill local school operating tax and noticeably lowering the bill.')) +

        sec("Ownership",
          '<ul class="pp-timeline">' +
          '<li><span class="pp-t-date">2014</span>Conveyed to ' + esc(owner) + ' (warranty deed)</li>' +
          '<li><span class="pp-t-date">2003</span>Conveyed to prior owner</li>' +
          '<li><span class="pp-t-date">1971</span>Parcel created from a 40-acre split</li>' +
          '</ul><p class="pp-note">Full chain of title + recorded instruments. ' + samp() + '</p>' +
          explain('owner', 'The <b>chain of title</b> traces ownership in an unbroken line back to the original 1971 parcel split — no gaps, breaks, or competing claims appear in the record, which is exactly what a title company verifies before issuing title insurance. Each transfer shown is backed by a recorded <b>warranty deed</b>, the strongest form of conveyance, in which the seller guarantees clear ownership free of undisclosed liens.')) +

        sec("Tax Description",
          '<div class="pp-legal"><div class="pp-legal-doc">' + esc(legalDesc) + '</div>' +
          '<figure class="pp-aliquot">' + aliquotSvg +
            '<figcaption class="pp-aliquot-cap">Parcel sits in the <b>NW¼ of the NW¼</b></figcaption>' +
          '</figure></div>' +
          '<p class="pp-note">Verbatim legal description from the tax roll. ' + samp() + '</p>' +
          explain('taxdesc', 'This is a <b>metes-and-bounds</b> description — it walks the boundary leg by leg. <b>T1S R13W</b> places the land in the Public Land Survey grid (Township 1 South, Range 13 West of the Michigan Meridian); <b>Sec 1</b> is one square mile — 640 acres — divided into quarters and quarter-quarters. <b>“COM AT NW COR”</b> starts at the section\'s northwest corner, and each <b>“TH”</b> (thence) gives a compass bearing and a distance in feet until the boundary closes back at the <b>“POB”</b> (point of beginning). Those calls enclose a 200 × 509.6 ft rectangle in the <b>NW¼ of the NW¼</b> — the northwest 40 acres of the section — about 2.34 acres. <b>M/L</b> means “more or less.”')) +

        sec("Environmental",
          '<div class="pp-pills">' +
          '<span class="pp-pill pp-ok">No FEMA flood zone</span>' +
          '<span class="pp-pill pp-ok">No NWI wetlands within 200 ft</span>' +
          '<span class="pp-pill">Soils: Oshtemo sandy loam</span>' +
          '<span class="pp-pill">Slope: 0–6%</span></div>' +
          explain('env', '<b>Oshtemo sandy loam</b> is a deep, well-drained soil — water moves through it quickly, so the parcel sheds rain well and is generally favorable for a conventional septic field and stable building foundations. The trade-off is that sandy soils hold less water and fewer nutrients, so lawns, gardens, or crops may need irrigation in a dry summer. The gentle <b>0–6% slope</b> means little grading is needed to build and erosion risk is low. Because no part of the parcel lies in a <b>FEMA flood zone</b> or a <b>mapped wetland</b>, it avoids the building setbacks, state permits, and mandatory flood insurance those designations would otherwise trigger.')) +

        sec("70-Year Aerial History",
          '<div class="pp-aerials">' + aerials + '</div>' +
          '<p class="pp-note">Swipe through decades of imagery in the live Packet. ' + samp() + '</p>' +
          explain('aerial', 'Stacking aerial imagery across seven decades turns a single snapshot into a story: you can see roughly when the home and outbuildings were built, how the tree line and driveway shifted, and whether the land was ever farmed, cleared, or filled. That history is often invisible in today\'s records but matters for drainage, buried structures, and questions about prior land use.')) +

        sec("Documents & Survey Notes",
          '<ul class="pp-docs">' +
          '<li>📄 Warranty Deed (2014) — Liber 1444, Page 933</li>' +
          '<li>📄 Tax statement (current year)</li>' +
          '<li>📐 County Surveyor field notes — Section 1, T1S R13W</li>' +
          '</ul><p class="pp-note">Linked from the County Knowledge Base — searchable and AI-readable. ' + samp() + '</p>' +
          explain('docs', 'These records are the primary sources behind everything above — the <b>deed</b> establishes ownership, the <b>tax statement</b> itemizes the bill, and the <b>County Surveyor\'s field notes</b> document the actual monuments and measurements that fix this parcel\'s boundaries on the ground. In the live Packet each is linked, full-text searchable, and readable by the A.I. so you can simply ask a question instead of digging through filings.')) +

        '<div class="pp-monitor"><div class="pp-monitor-h">🔔 Monitor this parcel</div>' +
          '<p>Get alerted when assessment, ownership, boundaries, or permits change. A monitoring subscription keeps this Packet live.</p>' +
          '<button type="button" class="pv-btn-primary" id="pp-monitor-btn">Subscribe to monitoring</button></div>' +

        '<p class="pp-footer">DICE Labs &middot; Parcel Packet (preview). Illustrative sample for demonstration — not a legal record of survey. ' +
          'The live Packet is generated on demand from the County Knowledge Base.</p>' +

      '</div>' +
    '</div>';

    openModal("Parcel Packet", html, function (bodyEl) {
      var btn = bodyEl.querySelector("#pp-monitor-btn");
      if (btn) btn.addEventListener("click", function () { btn.textContent = "On the roadmap ✓"; btn.disabled = true; });

      // Share / Embed panel toggle + copy buttons.
      var shareBtn = bodyEl.querySelector("#pp-share-btn"), sharePanel = bodyEl.querySelector("#pp-share");
      if (shareBtn && sharePanel) {
        shareBtn.addEventListener("click", function () {
          var open = !sharePanel.hidden;
          sharePanel.hidden = open;
          shareBtn.setAttribute("aria-expanded", String(!open));
          shareBtn.classList.toggle("is-on", !open);
          if (!open) sharePanel.scrollIntoView({ block: "nearest" });
        });
        [].forEach.call(sharePanel.querySelectorAll(".pp-share-copy"), function (c) {
          c.addEventListener("click", function () {
            var field = c.parentNode.querySelector(".pp-share-in");
            try { if (field && navigator.clipboard) navigator.clipboard.writeText(field.value); } catch (x) {}
            var prev = c.textContent; c.textContent = "Copied ✓";
            setTimeout(function () { c.textContent = prev; }, 1400);
          });
        });
      }

      // Wire the section-scoped "What this means" chat panels.
      [].forEach.call(bodyEl.querySelectorAll(".pp-explain[data-qa]"), function (block) {
        var cfg = PACKET_QA[block.getAttribute("data-qa")] || { qa: [] };
        var thread = block.querySelector(".pp-qa-thread");
        var form = block.querySelector(".pp-qa-form");
        var input = block.querySelector(".pp-qa-input");
        function answerFor(q) {
          var n = q.toLowerCase().trim();
          var hit = cfg.qa.filter(function (x) { return x.q.toLowerCase() === n; })[0];
          return hit ? hit.a
            : "That's exactly what the live Packet answers — it would read this parcel's records from the County Knowledge Base and reply right here in plain language. This preview ships with a few sample questions; the production Packet answers anything. (Sample preview.)";
        }
        function ask(q) {
          q = (q || "").trim();
          if (!q) return;
          var qRow = document.createElement("div"); qRow.className = "pp-qa-row pp-qa-q"; qRow.textContent = q;
          var aRow = document.createElement("div"); aRow.className = "pp-qa-row pp-qa-a";
          aRow.innerHTML = '<span class="pp-qa-dots" aria-label="Thinking">•••</span>';
          thread.appendChild(qRow); thread.appendChild(aRow);
          var ans = answerFor(q);
          setTimeout(function () { aRow.textContent = ans; thread.scrollIntoView({ block: "nearest" }); }, 550);
        }
        [].forEach.call(block.querySelectorAll(".pp-qa-chip"), function (chip) {
          chip.addEventListener("click", function () { ask(chip.textContent); });
        });
        if (form) form.addEventListener("submit", function (e) { e.preventDefault(); var v = input.value; input.value = ""; ask(v); });
      });

      // Wire the Parcel Ledger (ribbon + filterable list + synced inset).
      (function () {
        var insetCap = bodyEl.querySelector(".pp-linset-cap");
        var insetImg = bodyEl.querySelector(".pp-linset-img");
        if (!insetImg) return;
        function rows() { return bodyEl.querySelectorAll(".pp-levent"); }
        function selectEvent(i) {
          [].forEach.call(rows(), function (r) { r.classList.toggle("is-sel", r.getAttribute("data-li") === String(i)); });
          [].forEach.call(bodyEl.querySelectorAll(".pp-ltick"), function (t) { t.classList.toggle("is-sel", t.getAttribute("data-li") === String(i)); });
          var e = LEDGER[i];
          insetCap.innerHTML = 'Parcel as of <b>' + e.y + '</b> — ' + esc(e.t) + '. <span class="pp-samp">preview</span>';
          insetImg.style.background = e.y < 1971 ? "linear-gradient(135deg,#d8d2c4,#bcae8e)" : "linear-gradient(135deg,#cfd6c8,#9fb08f)";
        }
        [].forEach.call(bodyEl.querySelectorAll(".pp-levent-head"), function (h) {
          h.addEventListener("click", function () {
            var li = h.parentNode, exp = li.querySelector(".pp-lexplain"), open = h.getAttribute("aria-expanded") === "true";
            h.setAttribute("aria-expanded", String(!open));
            if (exp) exp.hidden = open;
            selectEvent(parseInt(li.getAttribute("data-li"), 10));
          });
        });
        [].forEach.call(bodyEl.querySelectorAll(".pp-ltick"), function (t) {
          t.addEventListener("click", function () {
            var i = parseInt(t.getAttribute("data-li"), 10);
            selectEvent(i);
            var row = bodyEl.querySelector('.pp-levent[data-li="' + i + '"]');
            if (row) row.scrollIntoView({ block: "nearest" });
          });
        });
        var active = {}; Object.keys(LCATS).forEach(function (k) { active[k] = true; });
        function applyFilter() {
          [].forEach.call(rows(), function (r) { r.style.display = active[r.getAttribute("data-cat")] ? "" : "none"; });
          [].forEach.call(bodyEl.querySelectorAll(".pp-ltick"), function (t) { t.style.opacity = active[LEDGER[t.getAttribute("data-li")].cat] ? "1" : "0.15"; });
          [].forEach.call(bodyEl.querySelectorAll(".pp-lchip"), function (c) {
            var k = c.getAttribute("data-cat");
            if (k === "all") c.classList.toggle("is-off", Object.keys(active).every(function (x) { return !active[x]; }));
            else c.classList.toggle("is-off", !active[k]);
          });
        }
        [].forEach.call(bodyEl.querySelectorAll(".pp-lchip"), function (chip) {
          chip.addEventListener("click", function () {
            var cat = chip.getAttribute("data-cat");
            if (cat === "all") { var allOn = Object.keys(active).every(function (k) { return active[k]; }); Object.keys(active).forEach(function (k) { active[k] = !allOn; }); }
            else active[cat] = !active[cat];
            applyFilter();
          });
        });
      })();
    }, { wide: true, flush: true });
  }
  function openCompare() {
    openModal("Compare Parcels", [
      '<p class="pv-modal-lead">Side-by-side comparison of 2–5 parcels.</p>',
      '<p>Compare assessment, size, zoning, and environmental attributes — useful for appeals, neighbor comparisons, and due diligence.</p>',
      placeholderTag("Coming soon.")
    ].join(""));
  }
  function openStreetView() {
    var pc = window.PS_STATE && window.PS_STATE.parcel;
    var c  = pc && pc.centroid;
    if (!pc || !c || c[0] == null || c[1] == null) {
      openModal("Street View", [
        '<p class="pv-modal-lead">Select a parcel first.</p>',
        '<p>Click a parcel on the map (or search for one), then open Street View to jump to street-level imagery at that location.</p>'
      ].join(""));
      return;
    }
    var url = "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=" +
      encodeURIComponent(c[1] + "," + c[0]);
    window.open(url, "_blank", "noopener");
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
      if (window.PS_STATE && window.PS_STATE.parcel && window.PS_STATE.parcel.pin) return window.PS_STATE.parcel.pin;
      if (window.PS_SELECTED_PIN) return window.PS_SELECTED_PIN;
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
  function formSuccessHtml(successTitle, successMsg) {
    return '<div class="pv-form-success">' +
      '<div class="pv-form-success-icon">&#10003;</div>' +
      '<div class="pv-form-success-title">' + successTitle + '</div>' +
      '<p class="pv-form-success-msg">' + successMsg + '</p>' +
      '<button type="button" class="pv-btn-primary" data-close>Close</button>' +
    '</div>';
  }

  // Real form submit — POSTs JSON to the API and shows success / error states.
  function wireFormPost(endpoint, successTitle, successMsg) {
    return function (bodyEl) {
      var form = bodyEl.querySelector("form");
      if (!form) return;
      bodyEl.addEventListener("click", function (e) { if (e.target.closest("[data-close]")) closeModal(); });
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (!form.checkValidity()) { form.reportValidity(); return; }
        var data = {};
        Array.prototype.forEach.call(form.elements, function (el) { if (el.name) data[el.name] = el.value; });
        var submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.dataset.label = submitBtn.textContent; submitBtn.textContent = "Sending…"; }
        var base = window.API_BASE || "/api";
        fetch(base + endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
          .then(function (res) {
            if (res && res.ok === false) return Promise.reject(new Error(res.error || "Server error"));
            bodyEl.innerHTML = formSuccessHtml(successTitle, successMsg);
            bodyEl.querySelector("[data-close]").addEventListener("click", closeModal);
          })
          .catch(function () {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = submitBtn.dataset.label || "Send"; }
            var errEl = form.querySelector(".pv-form-error");
            if (!errEl) {
              errEl = document.createElement("p");
              errEl.className = "pv-form-error";
              errEl.setAttribute("role", "alert");
              form.insertBefore(errEl, form.querySelector(".pv-form-actions"));
            }
            errEl.textContent = "Sorry — couldn’t send your report just now. Please try again.";
          });
      });
    };
  }

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
