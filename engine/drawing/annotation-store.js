/**
 * annotation-store.js — AnnotationStore
 *
 * Central state container for every drawn annotation in the application.
 * Consumed by:
 *   - DrawingTools (Phase 2): reads/writes annotations during active drawing
 *   - ParcelSketch (Phase 6): attaches metadata to annotation features
 *   - MapControlAPI (Phase 4): programmatic read/write via the AI advisor
 *   - map.js: subscribes to drive the MapLibre "annotation-source" layer
 *   - UndoRedoManager (undo-redo.js): wraps mutating methods to auto-snapshot
 *
 * Exposed as: window.PS_ANNOTATION_STORE
 */
(function () {
  'use strict';

  // ── UUID v4 generator ────────────────────────────────────────────────────
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // ── Default AnnotationStyle ──────────────────────────────────────────────
  /**
   * @typedef {Object} AnnotationStyle
   * @property {string}  strokeColor   hex colour for stroke
   * @property {number}  strokeWidth   stroke width in px
   * @property {'solid'|'dashed'|'dotted'} strokeDash
   * @property {string}  fillColor     hex colour for fill
   * @property {number}  fillOpacity   0-1
   * @property {number}  fontSize      label font size in px
   * @property {string}  fontColor     hex colour for label text
   * @property {boolean} arrowStart    arrowhead at start of line
   * @property {boolean} arrowEnd      arrowhead at end of line
   */
  var DEFAULT_STYLE = {
    strokeColor:  '#1d4ed8',
    strokeWidth:  2,
    strokeDash:   'solid',
    fillColor:    '#3b82f6',
    fillOpacity:  0.18,
    fontSize:     12,
    fontColor:    '#1f2937',
    arrowStart:   false,
    arrowEnd:     false,
  };

  // ── AnnotationStore ──────────────────────────────────────────────────────
  /**
   * @typedef {Object} StoreState
   * @property {GeoJSON.FeatureCollection} annotations
   * @property {string[]}                  layerGroups
   * @property {Object.<string,boolean>}   layerVisibility
   * @property {string[]}                  selectedAnnotationIds
   * @property {string}                    activeLayerGroup
   */

  function AnnotationStore() {
    this._annotations          = { type: 'FeatureCollection', features: [] };
    this._layerGroups          = ['Default'];
    this._layerVisibility      = { Default: true };
    this._selectedAnnotationIds = [];
    this._activeLayerGroup     = 'Default';
    this._listeners            = [];   // post-mutation subscribers
  }

  // ── Subscription (post-mutation) ─────────────────────────────────────────

  /**
   * Subscribe to store changes.
   * @param {function(StoreState): void} fn
   * @returns {function} unsubscribe
   */
  AnnotationStore.prototype.subscribe = function (fn) {
    this._listeners.push(fn);
    var self = this;
    return function () {
      self._listeners = self._listeners.filter(function (l) { return l !== fn; });
    };
  };

  AnnotationStore.prototype._notify = function () {
    var state = this.getState();
    for (var i = 0; i < this._listeners.length; i++) {
      try { this._listeners[i](state); } catch (e) { console.warn('AnnotationStore listener error', e); }
    }
  };

  // ── State accessors ──────────────────────────────────────────────────────

  /** @returns {StoreState} shallow copy of current state */
  AnnotationStore.prototype.getState = function () {
    return {
      annotations:             this._annotations,
      layerGroups:             this._layerGroups.slice(),
      layerVisibility:         Object.assign({}, this._layerVisibility),
      selectedAnnotationIds:   this._selectedAnnotationIds.slice(),
      activeLayerGroup:        this._activeLayerGroup,
    };
  };

  /**
   * Deep snapshot for undo/redo (annotations + layer structure only, no UI state).
   * @returns {Object} snapshot
   */
  AnnotationStore.prototype.snapshot = function () {
    return {
      annotations:     JSON.parse(JSON.stringify(this._annotations)),
      layerGroups:     this._layerGroups.slice(),
      layerVisibility: Object.assign({}, this._layerVisibility),
    };
  };

  /**
   * Restore from a snapshot (called by UndoRedoManager).
   * @param {Object} snap
   */
  AnnotationStore.prototype.restore = function (snap) {
    this._annotations     = snap.annotations;
    this._layerGroups     = snap.layerGroups;
    this._layerVisibility = snap.layerVisibility;
    this._notify();
  };

  /**
   * Returns the annotations FeatureCollection filtered to visible groups.
   * Used by map.js to drive the annotation-source layer.
   * @returns {GeoJSON.FeatureCollection}
   */
  AnnotationStore.prototype.getVisibleAnnotations = function () {
    var vis = this._layerVisibility;
    return {
      type: 'FeatureCollection',
      features: this._annotations.features.filter(function (f) {
        return vis[f.properties.layerGroup] !== false;
      }),
    };
  };

  // ── Annotation mutations ─────────────────────────────────────────────────

  /**
   * Add a new annotation feature to the store.
   * Any unset properties are filled with defaults.
   * @param {Object} feature  partial GeoJSON Feature
   * @returns {string} the assigned id
   */
  AnnotationStore.prototype.addAnnotation = function (feature) {
    var now = new Date().toISOString();
    var id  = (feature && feature.id) ? String(feature.id) : uuid();
    var props = (feature && feature.properties) ? feature.properties : {};
    var style = Object.assign({}, DEFAULT_STYLE, props.style || {});

    var f = {
      type:     'Feature',
      id:       id,
      geometry: (feature && feature.geometry) ? feature.geometry : null,
      properties: {
        layerGroup:  props.layerGroup  || this._activeLayerGroup,
        featureType: props.featureType || 'polygon',
        label:       props.label       !== undefined ? props.label : null,
        labelAuto:   props.labelAuto   !== undefined ? props.labelAuto : false,
        style:       style,
        createdAt:   props.createdAt   || now,
        updatedAt:   now,
        metadata:    props.metadata    || {},
      },
    };

    this._annotations = {
      type: 'FeatureCollection',
      features: this._annotations.features.concat([f]),
    };
    this._notify();
    return id;
  };

  /**
   * Update an existing annotation by id.
   * Pass geometry and/or properties (deep-merged into existing).
   * @param {string} id
   * @param {Object} changes  { geometry?, properties?: { style?, ...other } }
   */
  AnnotationStore.prototype.updateAnnotation = function (id, changes) {
    var now = new Date().toISOString();
    this._annotations = {
      type: 'FeatureCollection',
      features: this._annotations.features.map(function (f) {
        if (f.id !== id) return f;
        var props   = changes.properties || {};
        var newStyle = Object.assign({}, f.properties.style, props.style || {});
        var merged  = Object.assign({}, f.properties, props, {
          style:     newStyle,
          updatedAt: now,
        });
        return Object.assign({}, f, {
          geometry:   changes.geometry !== undefined ? changes.geometry : f.geometry,
          properties: merged,
        });
      }),
    };
    this._notify();
  };

  /**
   * Delete a single annotation by id.
   * @param {string} id
   */
  AnnotationStore.prototype.deleteAnnotation = function (id) {
    this._annotations = {
      type: 'FeatureCollection',
      features: this._annotations.features.filter(function (f) { return f.id !== id; }),
    };
    this._selectedAnnotationIds = this._selectedAnnotationIds.filter(function (i) { return i !== id; });
    this._notify();
  };

  /**
   * Delete multiple annotations by id array.
   * @param {string[]} ids
   */
  AnnotationStore.prototype.deleteAnnotations = function (ids) {
    var set = {};
    ids.forEach(function (id) { set[id] = true; });
    this._annotations = {
      type: 'FeatureCollection',
      features: this._annotations.features.filter(function (f) { return !set[f.id]; }),
    };
    this._selectedAnnotationIds = this._selectedAnnotationIds.filter(function (i) { return !set[i]; });
    this._notify();
  };

  /** Remove all annotations from the store. */
  AnnotationStore.prototype.clearAll = function () {
    this._annotations          = { type: 'FeatureCollection', features: [] };
    this._selectedAnnotationIds = [];
    this._notify();
  };

  // ── Layer group mutations ────────────────────────────────────────────────

  /** @param {string} name */
  AnnotationStore.prototype.addLayerGroup = function (name) {
    if (this._layerGroups.indexOf(name) !== -1) return;
    this._layerGroups = this._layerGroups.concat([name]);
    this._layerVisibility = Object.assign({}, this._layerVisibility, { [name]: true });
    this._notify();
  };

  /**
   * Remove a layer group. Orphaned annotations are moved to 'Default'.
   * The 'Default' group is protected and cannot be removed.
   * @param {string} name
   */
  AnnotationStore.prototype.removeLayerGroup = function (name) {
    if (name === 'Default') return;
    this._layerGroups = this._layerGroups.filter(function (g) { return g !== name; });
    var vis = Object.assign({}, this._layerVisibility);
    delete vis[name];
    this._layerVisibility = vis;
    this._annotations = {
      type: 'FeatureCollection',
      features: this._annotations.features.map(function (f) {
        if (f.properties.layerGroup !== name) return f;
        return Object.assign({}, f, {
          properties: Object.assign({}, f.properties, { layerGroup: 'Default' }),
        });
      }),
    };
    this._notify();
  };

  /**
   * @param {string}  groupName
   * @param {boolean} visible
   */
  AnnotationStore.prototype.setLayerVisibility = function (groupName, visible) {
    this._layerVisibility = Object.assign({}, this._layerVisibility, { [groupName]: visible });
    this._notify();
  };

  /** @param {string} name — must already exist in layerGroups */
  AnnotationStore.prototype.setActiveLayerGroup = function (name) {
    if (this._layerGroups.indexOf(name) === -1) return;
    this._activeLayerGroup = name;
    // no notify — this is UI-only state, not rendered
  };

  // ── Selection ────────────────────────────────────────────────────────────

  /** @param {string[]} ids */
  AnnotationStore.prototype.setSelectedAnnotationIds = function (ids) {
    this._selectedAnnotationIds = ids.slice();
    this._notify();
  };

  // ── Query helpers ────────────────────────────────────────────────────────

  /** @param {string} id @returns {GeoJSON.Feature|null} */
  AnnotationStore.prototype.getAnnotationById = function (id) {
    return this._annotations.features.find(function (f) { return f.id === id; }) || null;
  };

  /** @param {string} groupName @returns {GeoJSON.Feature[]} */
  AnnotationStore.prototype.getAnnotationsByGroup = function (groupName) {
    return this._annotations.features.filter(function (f) {
      return f.properties.layerGroup === groupName;
    });
  };

  /** @param {string} featureType @returns {GeoJSON.Feature[]} */
  AnnotationStore.prototype.getAnnotationsByType = function (featureType) {
    return this._annotations.features.filter(function (f) {
      return f.properties.featureType === featureType;
    });
  };

  // ── Export ───────────────────────────────────────────────────────────────
  window.PS_ANNOTATION_STORE = new AnnotationStore();

}());
