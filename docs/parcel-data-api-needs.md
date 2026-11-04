# What the Parcel Viewer reads from db-dice today

**Purpose.** Parcel data is moving out of db-dice into a private database behind `parcel-data-api`, and the viewer will become a token-authenticated client of it (ADR 0018, #105). This lists everything the viewer and its tile server read from db-dice today, so the `parcel-data-api` contract can be checked against it.

**As of 2026-11-04**, main `09a9f8b`. Sources:
- `api/parcels/repositories.py` (all parcel reads) and `api/parcels/cohort_query.py` (cohort filters);
- `api/county_config/discovery.py` (admin layer discovery) and `api/common/services.py` (health check);
- `infra/martin/martin.yaml`, with the tile functions as copied into `e2e/fixture/10-schema.sql`.

Geometry is stored in EPSG:2253 (Michigan South, US survey feet) and leaves the viewer as GeoJSON in EPSG:4326.

---

## 1. Tables and columns

| Table | Columns read | Used by |
|---|---|---|
| `geo.parcel_geometry` | `id`, `parcel_no`, `county`, `municipality`, `acres`, `area`, `geom`, `source`, `source_file`, `cogo_legs`, `legal_description`, `tax_description`, `created_at`, `updated_at`, `archived_at` (always filtered to `IS NULL`) | Every parcel route, cohorts, tiles |
| `assessing.vbc_parcels` (joined on `pnum = parcel_no`) | `owner_name`, `prop_street`, `prop_city`, `prop_state`, `prop_zip`, `owner_street`, `owner_city`, `owner_state`, `owner_zip`, `school_dist`, `prop_class`, `homestead`, `qual_ag`, `frontage`, `avg_depth`, `assessed_value`, `taxable_value`, `prev_assessed_value`, `prev_taxable_value`, `assessed_value_yr0` … `yr4`, `legal_description`, `loaded_at` | Parcel detail, search, map index, cohorts, tiles |
| `geo.parcel_ledger_events` | `event_id`, `parcel_id`, `event_type`, `event_timestamp`, `source_document`, `closure_error`, `precision_ratio`, `bowditch_applied`, `related_parcel_ids` | Parcel history |
| `geo.reference_layers` | `geom`, `feature_type` (`road`, `drain`, `section_line`) | Nearest road, Street View target, tiles |
| `geo.address_points` | `geom`, `fulladdr` | Street View target, tiles |
| `geo.subdivisions` | id, name, `geom` | Cohort by subdivision, geography lists, tiles |
| `geo.plss_sections` | id, name, `geom` | Cohort by section, geography lists, tiles |
| Tile-only layers | `geo.plss_corners`, `geo.road_centerlines`, `geo.drains`, section centers, parcel points | Tiles only (section 3) |

Owner names and mailing addresses are public (decided 2026-10-16), but the viewer meters detailed records per county (ADR 0015). That metering stays in the viewer.

## 2. What each viewer route needs

| Viewer route | What it asks the database | Spatial work |
|---|---|---|
| `GET /parcel/{id}` | One parcel with every column above, plus its geometry (7 decimal places) and the geodesic area in acres | Area on the geography type |
| `GET /parcels?bbox&limit` | Parcels whose geometry overlaps a bounding box (4326 in, 2253 index), up to a limit, with the summary columns (`id`, PIN, municipality, acres, owner, street, class, school district, assessed and taxable value) and geometry at 6 decimal places | Bounding-box overlap. **Called on every map move** to fill the parcel index |
| `GET /search?q&limit` | Up to 8 words; every word must match PIN, owner, street or city (case-insensitive, substring). Ranked: street starts with the phrase, then street + city starts with it, then street contains it, then a numeric first word as a whole house number. Each result returns `id`, PIN, municipality, acres, owner, street, city and its bounding box in 4326 | Per-result bounding box. Called as people type |
| `GET /parcel/{id}/history` | Ledger events where the parcel is the subject or in `related_parcel_ids`, newest first, with a limit | None |
| `GET /nearest-road?lng&lat` | The closest point on the nearest road to a point | Nearest-neighbour (`<->`) and closest point |
| `GET /streetview-target?id` | The address point inside the parcel (or a point on its surface), the closest point on the nearest road, and the address | Containment, point-on-surface, nearest road |
| `POST /cohort` | Parcels matching one selector, with the summary columns plus prior-year values and **no geometry**, up to a cap; plus the centre of their combined extent | See selectors below |
| `GET /cohort/geographies` | Lists for the pickers: subdivisions and sections (id, name), distinct townships and school districts | None |
| `GET /health` | `SELECT 1` on the parcel connection | None |
| `GET /admin/discover/layers` (staff only) | The `geo.*_tiles` functions, and each layer's geometry type, SRID and row count | Catalog queries |

**Cohort selectors** (`cohort_query.py`):
- **Explicit:** a list of parcel ids or PINs.
- **Buffer:** parcels within a distance in feet of a parcel, or of a point.
- **Named geography:** parcels intersecting a subdivision or section (by id or by name, union of matches), or matching a township or school district by attribute.
- **Drawn polygon:** parcels intersecting a GeoJSON Polygon or MultiPolygon in 4326.

**Map Buddy** reaches parcel data only through these viewer routes (`/search`, `/parcel/{id}`, `/environment`), with its service key (DIC-2202). It doesn't connect to db-dice for parcels.

## 3. Map tiles (Martin)

Martin connects to db-dice and serves these PostGIS functions as vector tiles:

`parcel_tiles`, `parcel_points_tiles`, `address_points_tiles`, `subdivisions_tiles`, `plss_sections_tiles`, `plss_section_lines_tiles`, `plss_corners_tiles`, `section_centers_tiles`, `road_centerlines_tiles`, `reference_roads_tiles`, `reference_drains_tiles`, `reference_section_lines_tiles`, `drains_tiles`.

`parcel_tiles` carries `id`, PIN, municipality, acres, owner name, street (`PCOMBINED`) and property class per parcel, filtered to unarchived parcels. The choropleth views read these attributes from the tiles. (Copied from the fixture's dump of the production functions; county-data-services owns the definitions.)

Tiles are the highest-volume traffic: every pan and zoom requests several per layer. Whatever replaces them (Martin on the new database, or the API serving tiles) needs the same layer names and attributes, or the viewer's styles change with it.

## 4. Not affected

These stay with the viewer and don't touch db-dice:
- **Flood zones** for `/environment`: in the viewer's own Django database (DIC-2414).
- **County config store, staff accounts, Knox tokens, the ADR 0015 usage counters:** the Django database (or the config writer database).
- **Federal map services** (FEMA, USFWS, NRCS) through `/wms-proxy`.

One related question: **Map Buddy's knowledge base** can read db-dice when `KB_BACKEND=dice` (`KB_DATABASE_URL`). It's off by default, but the move may affect it.

## 5. Questions for the contract

1. **Endpoint shape:** one endpoint per need above, or a smaller set of general queries (by id, by bounding box, by filter)?
2. **Spatial filters:** will the API take a bounding box, a buffer in feet around a parcel or point, and an intersecting GeoJSON polygon? These drive the map index and cohorts.
3. **Geometry:** returned as GeoJSON in 4326? At what precision? The viewer uses 7 decimals for detail and 6 for the map index.
4. **Search:** does the ranking above live in the API, or does the viewer fetch candidates and rank them?
5. **Volume:** the bounding-box and search calls are frequent. What latency and rate limits apply to the viewer's service token?
6. **Metering:** the viewer meters visitors itself (ADR 0015), so the service token shouldn't be metered per record a second time.
7. **Ledger, reference layers, address points, subdivisions, sections:** do these move to the new database too?
8. **Tiles:** Martin on the new database, or tiles from the API (for example `django-vectortiles`)? Either way, the layer names and attributes in section 3 must stay the same.
