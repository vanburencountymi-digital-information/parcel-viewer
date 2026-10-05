/**
 * pv-vision.js — capture the map view for Map Buddy's vision look (DIC-2135).
 *
 *   PV_VISION.capture(map)        Promise → { data, media_type, width, height, view_width_ft }
 *                                 data = base64 JPEG, no data-URI prefix
 *   PV_VISION.fitSize(w, h, max)  { width, height } scaled down to fit max on the long edge
 *   PV_VISION.viewWidthFt(map)    east–west span of the view in feet, at its center
 *
 * First the camera is made still and flat: any fly-around is stopped, and a tilted or
 * rotated view is turned straight down, north up. A tilted view squashes everything
 * toward the horizon (ballfields at the far edge read as "tan basins"), and the first
 * live look was taken mid-orbit. The user's map is left flat, so they see what was read.
 *
 * Then it waits for the map to finish drawing (tiles loaded, camera still) — up to 5 s,
 * so a layer the AI just turned on is in the picture — and copies the canvas, scaled to
 * at most 2,576 px on the long edge (the vision model's high-resolution limit), as JPEG:
 * aerial imagery is several times smaller as JPEG than PNG. The map is created with
 * preserveDrawingBuffer, so the canvas still holds the last frame.
 *
 * Only the map canvas is sent: no panels, popups or chat.
 */
(function (root) {
  'use strict';

  var MAX_LONG_EDGE = 2576;
  var MAX_BYTES = 2000000;       // the server's VISION_MAX_IMAGE_BYTES
  var IDLE_TIMEOUT_MS = 5000;
  var QUALITIES = [0.85, 0.7, 0.55];

  function fitSize(width, height, max) {
    var long = Math.max(width, height);
    if (!(long > 0)) return { width: 0, height: 0 };
    var scale = Math.min(1, max / long);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  // After a camera change, wait for the next 'idle' even if the map looks settled: the
  // tiles for the new view may not have been requested yet.
  function waitForIdle(map, moved) {
    return new Promise(function (resolve) {
      var settled = function () {
        try { return map.loaded() && map.areTilesLoaded() && !map.isMoving(); } catch (e) { return true; }
      };
      if (!moved && settled()) { resolve(); return; }
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(); } };
      setTimeout(finish, IDLE_TIMEOUT_MS);
      map.once('idle', finish);
    });
  }

  // base64 length → decoded byte count
  function b64Bytes(b64) { return Math.floor(b64.length * 3 / 4); }

  // Stop any camera motion and turn the view straight down, north up. True if it moved.
  function holdFlat(map) {
    var moving = false;
    try { moving = !!(map.isMoving && map.isMoving()); } catch (e) {}
    try { if (root.PS_cancelCinematic) root.PS_cancelCinematic(); } catch (e) {}
    try { if (map.stop) map.stop(); } catch (e) {}
    try {
      if (map.getPitch() !== 0 || map.getBearing() !== 0) {
        map.jumpTo({ pitch: 0, bearing: 0 });
        return true;
      }
    } catch (e) {}
    return moving;
  }

  var FT_PER_DEG_LAT = 364000;   // ~111 km per degree, in feet
  function viewWidthFt(map) {
    try {
      var b = map.getBounds();
      var lat = (b.getNorth() + b.getSouth()) / 2;
      var ft = (b.getEast() - b.getWest()) * FT_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
      return ft > 0 && isFinite(ft) ? Math.round(ft) : null;
    } catch (e) { return null; }
  }

  function capture(map) {
    if (!map || !map.getCanvas) return Promise.reject(new Error('The map isn’t ready.'));
    var moved = holdFlat(map);
    return waitForIdle(map, moved).then(function () {
      var src = map.getCanvas();
      var size = fitSize(src.width, src.height, MAX_LONG_EDGE);
      if (!size.width) throw new Error('The map isn’t ready.');
      var out = document.createElement('canvas');
      out.width = size.width;
      out.height = size.height;
      var ctx = out.getContext('2d');
      ctx.fillStyle = '#ffffff';                  // JPEG has no alpha: no black gaps
      ctx.fillRect(0, 0, size.width, size.height);
      ctx.drawImage(src, 0, 0, size.width, size.height);
      for (var i = 0; i < QUALITIES.length; i++) {
        var data = out.toDataURL('image/jpeg', QUALITIES[i]).replace(/^data:image\/jpeg;base64,/, '');
        if (data && b64Bytes(data) <= MAX_BYTES) {
          return { data: data, media_type: 'image/jpeg', width: size.width, height: size.height,
            view_width_ft: viewWidthFt(map) };
        }
      }
      throw new Error('The map image is too large to send.');
    });
  }

  root.PV_VISION = { capture: capture, fitSize: fitSize, viewWidthFt: viewWidthFt, MAX_LONG_EDGE: MAX_LONG_EDGE };
})(typeof window !== 'undefined' ? window : globalThis);
