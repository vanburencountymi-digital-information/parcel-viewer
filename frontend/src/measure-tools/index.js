// The Measurement Tools pane as a Vue island (DIC-2389): mounts into #mcp-pane-measure.
// The map side and the results HUD stay drawing/measure-tool.js (PS_MEASURE_TOOL), which
// leaves the pane alone because it says data-ui="vue".
import { createApp } from 'vue';
import * as viewer from '../shared/viewer.js';
import MeasureTools from './MeasureTools.vue';

export function mountMeasureTools(doc = document) {
  const pane = doc.getElementById('mcp-pane-measure');
  const tool = viewer.measureTool();
  if (!pane || !tool || !tool.subscribe) return null;   // no pane, or the measure script didn't load
  // Mounting replaces the pane's children; its own attributes (hidden, role, data-ui) stay.
  return createApp(MeasureTools, { tool, annotations: viewer.annotations(), undo: viewer.undoRedo() }).mount(pane);
}
