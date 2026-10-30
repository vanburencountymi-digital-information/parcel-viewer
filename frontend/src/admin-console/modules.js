// The Admin Console's modules, in nav order (DIC-467; the registry moved from admin.js in
// DIC-2389, and each module became a Vue component).
import AccessOps from './modules/AccessOps.vue';
import CountyConfig from './modules/CountyConfig.vue';
import DataLayers from './modules/DataLayers.vue';
import Intelligence from './modules/Intelligence.vue';
import Styling from './modules/Styling.vue';
import ThemeManifest from './modules/ThemeManifest.vue';

export const MODULES = [
  { id: 'county', label: 'County Configuration', icon: '◆', component: CountyConfig },
  { id: 'intelligence', label: 'Intelligence', icon: '✦', component: Intelligence },
  { id: 'styling', label: 'Styling', icon: '◑', component: Styling },
  { id: 'data', label: 'Data & Layers', icon: '▤', component: DataLayers },
  { id: 'access', label: 'Access & Ops', icon: '◈', component: AccessOps },
  { id: 'manifest', label: 'Theme Manifest', icon: '❖', component: ThemeManifest },
];
