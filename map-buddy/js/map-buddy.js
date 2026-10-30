/* Map Buddy — pluggable AI assistant panel for MapLibre parcel viewers
 *
 * Attach:  MapBuddy.mount({ apiBase: '/api' });
 * Detach:  MapBuddy.unmount();
 *
 * The host page loads the map commands, this file, a mount, and the Vue entry:
 *   <script src="/map-buddy/js/map-buddy-commands.js"></script>
 *   <script src="/map-buddy/js/map-buddy.js"></script>
 *   <script>MapBuddy.mount({ apiBase: '/api' });</script>
 *   <script type="module" src="/frontend/src/main.js"></script>
 *
 * The panel is a Vue island since DIC-2389 (frontend/src/map-buddy). A module runs after
 * the page's classic scripts, so mount() called from one is remembered here and the
 * island does it when it loads; after that, mount() and unmount() act at once. Options:
 * apiBase, container (default #app), cssUrl (default /map-buddy/css/map-buddy.css).
 */
(function (root) {
  'use strict';

  var pending = null;   // the options of a mount() the island hasn't done yet
  var mounter = null;   // the island's mount(opts) → { unmount }, once it has loaded
  var live = null;      // the mounted panel

  root.MapBuddy = {
    mount: function (opts) {
      if (live) return;
      pending = opts || {};
      if (mounter) { live = mounter(pending); pending = null; }
    },
    unmount: function () {
      pending = null;
      if (live) { live.unmount(); live = null; }
    },
    /** The options mount() was called with, until the island does it. */
    get pending() { return pending; },
    /** For the island: registers how to mount, and does any mount already asked for. */
    attach: function (fn) {
      mounter = fn;
      if (pending && !live) { live = mounter(pending); pending = null; }
      return live;
    },
  };
})(window);
