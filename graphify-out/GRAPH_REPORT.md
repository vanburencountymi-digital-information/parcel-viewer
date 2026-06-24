# Graph Report - C:/Users/Drake/vbc/parcel-viewer  (2026-06-24)

## Corpus Check
- 55 files · ~107,167 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 895 nodes · 1852 edges · 56 communities (42 shown, 14 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 29 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Measurement Tool|Measurement Tool]]
- [[_COMMUNITY_Admin Menu UI|Admin Menu UI]]
- [[_COMMUNITY_Drawing Tools|Drawing Tools]]
- [[_COMMUNITY_MapBuddy AI Chat|MapBuddy AI Chat]]
- [[_COMMUNITY_Parcel Label Rendering|Parcel Label Rendering]]
- [[_COMMUNITY_Admin Layer Config|Admin Layer Config]]
- [[_COMMUNITY_Map Core|Map Core]]
- [[_COMMUNITY_Parcel AI Explain|Parcel AI Explain]]
- [[_COMMUNITY_MapBuddy Backend Agent|MapBuddy Backend Agent]]
- [[_COMMUNITY_Config Store|Config Store]]
- [[_COMMUNITY_Backend API App|Backend API App]]
- [[_COMMUNITY_User Hint System|User Hint System]]
- [[_COMMUNITY_Annotation Store|Annotation Store]]
- [[_COMMUNITY_Demo Layer Loading|Demo Layer Loading]]
- [[_COMMUNITY_PostGIS Layers|PostGIS Layers]]
- [[_COMMUNITY_WMS Overlay Layers|WMS Overlay Layers]]
- [[_COMMUNITY_MapBuddy Chat API|MapBuddy Chat API]]
- [[_COMMUNITY_Choropleth Visualization|Choropleth Visualization]]
- [[_COMMUNITY_WMS Feature Info|WMS Feature Info]]
- [[_COMMUNITY_Infra & Deployment Docs|Infra & Deployment Docs]]
- [[_COMMUNITY_Admin Console|Admin Console]]
- [[_COMMUNITY_Parcel Selection|Parcel Selection]]
- [[_COMMUNITY_Parcel Data API|Parcel Data API]]
- [[_COMMUNITY_County Layer Registry|County Layer Registry]]
- [[_COMMUNITY_FastAPI App Config|FastAPI App Config]]
- [[_COMMUNITY_Snapping Engine|Snapping Engine]]
- [[_COMMUNITY_Parcel Export|Parcel Export]]
- [[_COMMUNITY_Feedback & WMS Proxy|Feedback & WMS Proxy]]
- [[_COMMUNITY_Layer Registry|Layer Registry]]
- [[_COMMUNITY_Coordinate Formatting|Coordinate Formatting]]
- [[_COMMUNITY_A11y Proxy Tool|A11y Proxy Tool]]
- [[_COMMUNITY_UndoRedo History|Undo/Redo History]]
- [[_COMMUNITY_Search Results UI|Search Results UI]]
- [[_COMMUNITY_Parcel HTML Templates|Parcel HTML Templates]]
- [[_COMMUNITY_Design & Demo Setup|Design & Demo Setup]]
- [[_COMMUNITY_Legend Panel|Legend Panel]]
- [[_COMMUNITY_Choropleth Config|Choropleth Config]]
- [[_COMMUNITY_Parcel Tile Cache|Parcel Tile Cache]]
- [[_COMMUNITY_Buffer Analysis|Buffer Analysis]]
- [[_COMMUNITY_Shared FastAPI Dep|Shared FastAPI Dep]]
- [[_COMMUNITY_Shared Rate Limiter|Shared Rate Limiter]]
- [[_COMMUNITY_MapBuddy Deploy|MapBuddy Deploy]]
- [[_COMMUNITY_Demo Drawing Tools|Demo Drawing Tools]]
- [[_COMMUNITY_Demo Measure & Proj|Demo Measure & Proj]]
- [[_COMMUNITY_README Configs|README Configs]]
- [[_COMMUNITY_Router Init|Router Init]]
- [[_COMMUNITY_Demo Build Script|Demo Build Script]]
- [[_COMMUNITY_psycopg3 Dep|psycopg3 Dep]]
- [[_COMMUNITY_pydantic Dep|pydantic Dep]]
- [[_COMMUNITY_uvicorn Dep|uvicorn Dep]]
- [[_COMMUNITY_Demo Parcel Labels|Demo Parcel Labels]]

## God Nodes (most connected - your core abstractions)
1. `AnnotationStore()` - 20 edges
2. `openModal()` - 19 edges
3. `buildCentroids()` - 19 edges
4. `esc()` - 17 edges
5. `ConfigStore` - 16 edges
6. `finishBearingDist()` - 16 edges
7. `clearPreview()` - 15 edges
8. `runAutoDim()` - 15 edges
9. `wireEditHost()` - 14 edges
10. `getMap()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `layer-registry.js / PS_LAYER_REGISTRY` --semantically_similar_to--> `layer-registry.js Frontend Module`  [INFERRED] [semantically similar]
  HANDOFF.md → demo/index.html
- `county-config.js (window.COUNTY) Manifest` --semantically_similar_to--> `county-config.js (window.COUNTY) Script Reference`  [INFERRED] [semantically similar]
  docs/SESSION-HANDOFF.md → admin/index.html
- `DIC-463 Auth (Google SSO, replaces PV_ADMIN_TOKEN)` --semantically_similar_to--> `DIC-463 Auth Stubbed (not yet wired)`  [INFERRED] [semantically similar]
  docs/admin-console-provisioning.md → admin/index.html
- `FastAPI (backend dependency)` --semantically_similar_to--> `FastAPI (map-buddy dependency)`  [INFERRED] [semantically similar]
  backend/requirements.txt → map-buddy/backend/requirements.txt
- `SlowAPI Rate Limiter (backend dependency)` --semantically_similar_to--> `SlowAPI Rate Limiter (map-buddy dependency)`  [INFERRED] [semantically similar]
  backend/requirements.txt → map-buddy/backend/requirements.txt

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Docker Compose Viewer Stack Services** — infra_docker_compose_api_service, infra_docker_compose_martin_service, infra_docker_compose_web_service, infra_docker_compose_map_buddy_service [EXTRACTED 1.00]
- **Frontend Layer Registration Pipeline** — demo_index_overlay_layers_js, demo_index_county_layers_js, demo_index_pg_layers_js, demo_index_layer_registry_js, demo_index_map_buddy_js [EXTRACTED 0.95]
- **County Config Distribution Chain** — admin_index_county_config_js, docs_session_county_config_js, admin_index_dic465_runtime_config_api, docs_admin_provisioning_config_versions [INFERRED 0.85]

## Communities (56 total, 14 thin omitted)

### Community 0 - "Measurement Tool"
Cohesion: 0.10
Nodes (67): activateTool(), addAnnotation(), addLabelAnnotation(), azimuthBetween(), azimuthToQuadrant(), backBearing(), bearingDiff(), buildLabel() (+59 more)

### Community 1 - "Admin Menu UI"
Cohesion: 0.07
Nodes (66): a11yControlsHtml(), aboutRow(), applyAll(), applyScheme(), appVersion(), bmAdd(), bmHas(), bmList() (+58 more)

### Community 2 - "Drawing Tools"
Cohesion: 0.10
Nodes (61): angleBetween(), applySnap(), applyToCoords(), buildSwatches(), cancelCurrentDraw(), clearPreview(), clearSnapIndicator(), commit() (+53 more)

### Community 3 - "MapBuddy AI Chat"
Cohesion: 0.08
Nodes (47): _api(), _appendActionChips(), _appendAiMsg(), _appendInfoBubble(), _appendResultBubble(), _appendSuggestions(), _appendUserMsg(), _applyWidth() (+39 more)

### Community 4 - "Parcel Label Rendering"
Cohesion: 0.09
Nodes (46): activate(), addOrUpdateLayer(), _avgCharW(), _bboxDims(), buildCentroids(), _buildEntityTiers(), buildOwnerTiers(), _buildPersonTiers() (+38 more)

### Community 5 - "Admin Layer Config"
Cohesion: 0.12
Nodes (43): activeRenderer(), addDiscoveredLayer(), addPickedLayer(), apiWrite(), arrayAdd(), arrayAt(), arrayRemove(), clone() (+35 more)

### Community 6 - "Map Core"
Cohesion: 0.07
Nodes (17): applyMapMood(), _arrowBearing(), _cancelCine(), cleanup(), countyThemeDefault(), _ensureMoodOverlay(), handleBufferSeedClick(), initCoordReadout() (+9 more)

### Community 7 - "Parcel AI Explain"
Cohesion: 0.14
Nodes (29): apiBase(), assembleAssessmentFacts(), assembleTaxDescriptionFacts(), assessmentHeader(), buildData(), classifyDescription(), docHtml(), errorHtml() (+21 more)

### Community 8 - "MapBuddy Backend Agent"
Cohesion: 0.10
Nodes (28): _arcgis_point_query(), _assemble_system(), _build_user_message(), _cond_passes(), _exec_data_tool(), _expand_workflow(), explainer_profiles_public(), _get_client() (+20 more)

### Community 9 - "Config Store"
Cohesion: 0.15
Nodes (13): ConfigStore, _dialect(), is_configured(), Writable config store (DIC-464 / DIC-400 / DIC-466).  Holds the per-county con, The working draft, or the latest published if no draft exists yet., Replace the single working draft for this county., Promote the current draft to a new published version. Returns the version., Restore a prior version by publishing a copy of it as the new latest         ve (+5 more)

### Community 10 - "Backend API App"
Cohesion: 0.11
Nodes (25): config(), config_js(), _discover_layers(), DraftBody, get_config_draft(), _get_store(), _load_county_config(), publish_config() (+17 more)

### Community 11 - "User Hint System"
Cohesion: 0.15
Nodes (23): _aerialOn(), _buildSpotlight(), _candidates(), _closeCoach(), _coachKey(), _enabled(), _ensureRail(), _init() (+15 more)

### Community 13 - "Demo Layer Loading"
Cohesion: 0.11
Nodes (20): county-layers.js Frontend Module, hints.js Frontend Module, layer-registry.js Frontend Module, map-buddy.js AI Assistant Frontend Module, MapBuddy Cloud Run Service Endpoint, overlay-layers.js Frontend Module, pg-layers.js Frontend Module, wms-feature-info.js Frontend Module (+12 more)

### Community 14 - "PostGIS Layers"
Cohesion: 0.28
Nodes (19): addOverlay(), buildUI(), darkBackground(), esc(), getMap(), isDark(), labelStyle(), lineStyle() (+11 more)

### Community 15 - "WMS Overlay Layers"
Cohesion: 0.22
Nodes (15): _addOverlay(), _findById(), _getMap(), _hillshadePaint(), _isDark(), _isOurOverlay(), _onTileError(), _retintHillshade() (+7 more)

### Community 16 - "MapBuddy Chat API"
Cohesion: 0.16
Nodes (15): chat(), ChatMessage, ChatRequest, explain(), ExplainRequest, MapState, ParcelContext, Map Buddy microservice — standalone FastAPI backend for the Map Buddy AI assista (+7 more)

### Community 17 - "Choropleth Visualization"
Cohesion: 0.18
Nodes (18): _activeChoroView(), _applyChoroConfig(), applyTheme(), _buildChoroSelector(), _buildDynamicCategories(), _choroIsPlain(), choroplethLegendSections(), _choroValue() (+10 more)

### Community 18 - "WMS Feature Info"
Cohesion: 0.22
Nodes (16): _attrRows(), _buildHtml(), _buildWmsUrl(), _errResult(), _esc(), _fetchOne(), _fetchRest(), _fetchWithTimeout() (+8 more)

### Community 19 - "Infra & Deployment Docs"
Cohesion: 0.13
Nodes (17): Parcel Viewer Deployment Runbook, PostGIS Schema (geo.parcel_geometry, assessing.vbc_parcels), api Docker Service (FastAPI), map-buddy Docker Service (AI backend local), martin Docker Service (vector tiles), docker-compose.viewer.yml Stack, web Docker Service (nginx), Martin Auto-Publish from geo Schema (+9 more)

### Community 20 - "Admin Console"
Cohesion: 0.16
Nodes (15): Admin Console UI, admin.js Script, county-config.js (window.COUNTY) Script Reference, DIC-463 Auth Stubbed (not yet wired), DIC-465 Runtime Config API, style-preview.js (Admin Console draft preview), Admin Console Config Store (pv_writer role), config.config_versions Table (+7 more)

### Community 21 - "Parcel Selection"
Cohesion: 0.20
Nodes (15): addToSelection(), clearSelectionAll(), computeBounds(), computeCentroid(), cycleParcel(), flyToActiveParcel(), hideInfoPanel(), initMapControlPanel() (+7 more)

### Community 22 - "Parcel Data API"
Cohesion: 0.15
Nodes (11): Parcel Viewer — read-only PostGIS parcel map API., get_parcel(), nearest_road(), parcels_bbox(), Read endpoints: property card, omni-search, bbox parcel hydration, history.  A, Snap a point to the closest point on the nearest road (geo.reference_layers)., Best Street View setup for a parcel: anchor on the parcel's ADDRESS POINT     (, MapLibre style for the parcel map. (+3 more)

### Community 23 - "County Layer Registry"
Cohesion: 0.35
Nodes (12): _addMapLayers(), _beforeLayer(), _findById(), _getMap(), _layerIds(), _loadState(), _martinBase(), _registry() (+4 more)

### Community 24 - "FastAPI App Config"
Cohesion: 0.20
Nodes (8): health(), lifespan(), FastAPI, Parcel Viewer backend configuration (env-driven)., close_pool(), health_check(), open_pool(), PostgreSQL connection pool (psycopg3).

### Community 25 - "Snapping Engine"
Cohesion: 0.29
Nodes (5): _closestPointOnSegment(), _extractSegments(), _extractVertices(), _midpoint(), SnappingEngine()

### Community 26 - "Parcel Export"
Cohesion: 0.35
Nodes (9): captureMapImage(), downloadHtml(), downloadParcelSummary(), _fmtAcres(), parcelSummaryData(), parcelSummaryHtml(), _pinFor(), printParcelSummary() (+1 more)

### Community 27 - "Feedback & WMS Proxy"
Cohesion: 0.27
Nodes (9): _client_ip(), Proxy WMS GetFeatureInfo / GetLegendGraphic requests server-side.      Per-IP, wms_proxy(), Request, DataErrorReport, Public feedback endpoints — resident-submitted data-error reports.  Reports ar, Email a resident-reported data error to the county GIS inbox., report_error() (+1 more)

### Community 28 - "Layer Registry"
Cohesion: 0.40
Nodes (9): _checked(), _county(), _fire(), _parcelFields(), rebuild(), snapshot(), summary(), _vectorOverlays() (+1 more)

### Community 29 - "Coordinate Formatting"
Cohesion: 0.20
Nodes (10): _coordFormat(), _dd(), _dms(), _formatLngLat(), _renderCoords(), representativePoint(), rerenderOpenParcel(), showParcelInfo() (+2 more)

### Community 30 - "A11y Proxy Tool"
Cohesion: 0.29
Nodes (3): Proxy, Tiny reverse proxy: forwards :8091 -> Docker app at :8080. Lets the preview bro, ThreadingServer

### Community 32 - "Search Results UI"
Cohesion: 0.39
Nodes (8): clearResults(), closeMobileSearch(), hideResults(), renderSearchResults(), resetMobileSearch(), selectOption(), setActive(), setExpanded()

### Community 34 - "Parcel HTML Templates"
Cohesion: 0.52
Nodes (6): escape(), isEmpty(), lookup(), parse(), render(), renderNode()

### Community 35 - "Design & Demo Setup"
Cohesion: 0.40
Nodes (6): map.js Frontend Module, MapLibre GL JS (map renderer), Turf.js (spatial analysis library), Accessibility Mode (removes blur, increases contrast), Glass Elevation System (e0-e3 blur/tint layers), Spatial Glass UI Design Concept

### Community 36 - "Legend Panel"
Cohesion: 0.60
Nodes (5): _collapse(), _expand(), _loadLegendImage(), _toggle(), _wireAll()

### Community 37 - "Choropleth Config"
Cohesion: 0.33
Nodes (6): applyLayerPaint(), _choroKey(), _choroNumInput(), choroplethConfig(), choroplethFillExpr(), mapLayersFor()

### Community 38 - "Parcel Tile Cache"
Cohesion: 0.40
Nodes (5): absoluteMartinUrl(), _indexCoversViewport(), invalidateParcelCache(), refreshParcelIndex(), refreshParcelTiles()

### Community 39 - "Buffer Analysis"
Cohesion: 0.40
Nodes (5): clearBufferPreviewOnly(), clearBufferState(), computeBufferGeometry(), findParcelsInBuffer(), updateBufferPreview()

## Knowledge Gaps
- **37 isolated node(s):** `deploy.sh script`, `ThreadingServer`, `DIC-515 Reactive Overlay Pulse`, `DIC-526 Aerial Esri World Imagery`, `DIC-527 Choropleth Views` (+32 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `showParcelInfo()` connect `Coordinate Formatting` to `Parcel Selection`, `Map Core`?**
  _High betweenness centrality (0.069) - this node is a cross-community bridge._
- **Why does `dash()` connect `Coordinate Formatting` to `Parcel AI Explain`?**
  _High betweenness centrality (0.069) - this node is a cross-community bridge._
- **Why does `num()` connect `Parcel AI Explain` to `Admin Layer Config`?**
  _High betweenness centrality (0.065) - this node is a cross-community bridge._
- **What connects `Parcel Viewer backend — read-only FastAPI app.`, `Load a county manifest by key, or None if unknown. Path-safe (no traversal).`, `Lazily build the store (and ensure its table), or None if not configured.` to the rest of the system?**
  _84 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Measurement Tool` be split into smaller, more focused modules?**
  _Cohesion score 0.10020120724346077 - nodes in this community are weakly interconnected._
- **Should `Admin Menu UI` be split into smaller, more focused modules?**
  _Cohesion score 0.07163561076604555 - nodes in this community are weakly interconnected._
- **Should `Drawing Tools` be split into smaller, more focused modules?**
  _Cohesion score 0.09518773135906927 - nodes in this community are weakly interconnected._