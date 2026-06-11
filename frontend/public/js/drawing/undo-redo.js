/**
 * undo-redo.js — UndoRedoManager
 *
 * Maintains a bounded history of AnnotationStore snapshots and exposes
 * undo() / redo() operations.  Works by monkey-patching the store's mutating
 * methods so every mutation is automatically preceded by a snapshot — callers
 * need no special knowledge that undo/redo exists.
 *
 * Snapshot scope: annotations FeatureCollection + layerGroups/layerVisibility.
 * UI state (selectedAnnotationIds, activeLayerGroup) is intentionally excluded.
 *
 * Keyboard handler functions are exposed via getKeyboardHandlers() but are NOT
 * attached to the document here.  Phase 2 attaches them when the Drawing Tools
 * UI is mounted so they only fire when the drawing pane is active.
 *
 * Depends on: annotation-store.js (window.PS_ANNOTATION_STORE must exist)
 * Exposed as: window.PS_UNDO_REDO
 */
(function () {
  'use strict';

  var MAX_HISTORY = 25;

  // Names of AnnotationStore methods whose execution should be preceded
  // by an automatic snapshot.  restore() is excluded — it IS the undo action.
  var MUTATING_METHODS = [
    'addAnnotation',
    'updateAnnotation',
    'deleteAnnotation',
    'deleteAnnotations',
    'clearAll',
    'addLayerGroup',
    'removeLayerGroup',
    'setLayerVisibility',
  ];

  // ── UndoRedoManager ──────────────────────────────────────────────────────

  /**
   * @param {AnnotationStore} store  window.PS_ANNOTATION_STORE
   */
  function UndoRedoManager(store) {
    this._store   = store;
    this._past    = [];   // snapshots before mutations  (oldest → newest)
    this._future  = [];   // snapshots for redo          (most recent first)
    this._paused  = false; // set true during restore to suppress re-snapping

    this._wrapStoreMutations();
  }

  // ── Mutation interception ────────────────────────────────────────────────

  /**
   * Wrap each mutating store method so a snapshot is saved before it runs.
   * The original method is stored as _original_<name> for introspection/testing.
   */
  UndoRedoManager.prototype._wrapStoreMutations = function () {
    var self  = this;
    var store = this._store;

    MUTATING_METHODS.forEach(function (name) {
      var original = store[name].bind(store);
      store['_original_' + name] = original;

      store[name] = function () {
        if (!self._paused) {
          self._saveSnapshot();
        }
        return original.apply(store, arguments);
      };
    });
  };

  // ── Snapshot helpers ─────────────────────────────────────────────────────

  UndoRedoManager.prototype._saveSnapshot = function () {
    var snap = this._store.snapshot();
    this._past.push(snap);
    if (this._past.length > MAX_HISTORY) {
      this._past.shift();
    }
    // Any new action after an undo clears the redo stack
    this._future = [];
  };

  // ── Public API ───────────────────────────────────────────────────────────

  /** @returns {boolean} */
  Object.defineProperty(UndoRedoManager.prototype, 'canUndo', {
    get: function () { return this._past.length > 0; },
  });

  /** @returns {boolean} */
  Object.defineProperty(UndoRedoManager.prototype, 'canRedo', {
    get: function () { return this._future.length > 0; },
  });

  /** Undo the last store mutation. No-op if nothing to undo. */
  UndoRedoManager.prototype.undo = function () {
    if (!this.canUndo) return;
    // Push current state onto redo stack
    this._future.push(this._store.snapshot());
    // Restore previous state — pause interception so restore() doesn't snapshot
    this._paused = true;
    try {
      this._store.restore(this._past.pop());
    } finally {
      this._paused = false;
    }
  };

  /** Redo the last undone mutation. No-op if nothing to redo. */
  UndoRedoManager.prototype.redo = function () {
    if (!this.canRedo) return;
    this._past.push(this._store.snapshot());
    this._paused = true;
    try {
      this._store.restore(this._future.pop());
    } finally {
      this._paused = false;
    }
  };

  /** Clear all history (e.g. after loading a saved project). */
  UndoRedoManager.prototype.clearHistory = function () {
    this._past   = [];
    this._future = [];
  };

  /**
   * Returns a keydown handler object for Phase 2 to attach to the document
   * (or a scoped element) when the Drawing Tools pane is active.
   *
   * Usage in Phase 2:
   *   const { onKeydown } = window.PS_UNDO_REDO.getKeyboardHandlers();
   *   document.addEventListener('keydown', onKeydown);
   *   // ... and removeEventListener when pane closes
   *
   * @returns {{ onKeydown: function(KeyboardEvent): void }}
   */
  UndoRedoManager.prototype.getKeyboardHandlers = function () {
    var self = this;
    return {
      onKeydown: function (e) {
        var mod = e.ctrlKey || e.metaKey;
        if (!mod) return;

        // Ctrl+Z / Cmd+Z → undo
        if (!e.shiftKey && e.key === 'z') {
          e.preventDefault();
          self.undo();
          return;
        }
        // Ctrl+Shift+Z / Cmd+Shift+Z → redo
        if (e.shiftKey && e.key === 'z') {
          e.preventDefault();
          self.redo();
          return;
        }
        // Ctrl+Y / Cmd+Y → redo (Windows convention)
        if (!e.shiftKey && e.key === 'y') {
          e.preventDefault();
          self.redo();
        }
      },
    };
  };

  // ── Export ───────────────────────────────────────────────────────────────
  window.PS_UNDO_REDO = new UndoRedoManager(window.PS_ANNOTATION_STORE);

}());
