"""The MapLibre base style the viewer starts from (GET /style.json), as the FastAPI backend served it.

"{MARTIN_URL}" is a literal placeholder the viewer replaces with the tile server's URL.
"""

from typing import Any

MAP_CENTER = [-86.03, 42.24]

MAP_STYLE: dict[str, Any] = {
    "version": 8,
    "name": "Parcel Viewer Base Style",
    "center": MAP_CENTER,
    "zoom": 11,
    "glyphs": "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    "sources": {
        # Aerial basemap (DIC-526): Esri World Imagery, through the same-origin /aerial/
        # proxy that caches tiles (DIC-528). ArcGIS tiles are /{z}/{y}/{x} (row first).
        "mi-aerial": {
            "type": "raster",
            "tiles": ["/aerial/{z}/{y}/{x}"],
            "tileSize": 256,
            "maxzoom": 19,
            "attribution": "Imagery © Esri, Maxar, Earthstar Geographics, USDA FSA, USGS, and the GIS user community",
        },
        # Street basemap: Esri Light Gray Canvas (keyless). Its data stops at z16, so
        # maxzoom 16 makes MapLibre overzoom instead of showing "not yet available" tiles.
        "esri-canvas": {
            "type": "raster",
            "tiles": [
                "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"
            ],
            "tileSize": 256,
            "maxzoom": 16,
            "attribution": "Esri, HERE, Garmin, (c) OpenStreetMap contributors, and the GIS user community",
        },
        "esri-canvas-labels": {
            "type": "raster",
            "tiles": [
                "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}"
            ],
            "tileSize": 256,
            "maxzoom": 16,
        },
        "parcels": {
            "type": "vector",
            "tiles": ["{MARTIN_URL}/parcel_tiles/{z}/{x}/{y}"],
            "minzoom": 0,
            "maxzoom": 22,
            "promoteId": {"parcels": "pin"},
        },
    },
    "layers": [
        {"id": "basemap", "type": "raster", "source": "esri-canvas", "minzoom": 0, "maxzoom": 24},
        {
            "id": "basemap-labels",
            "type": "raster",
            "source": "esri-canvas-labels",
            "minzoom": 0,
            "maxzoom": 24,
        },
        {
            "id": "mi-aerial",
            "type": "raster",
            "source": "mi-aerial",
            "minzoom": 0,
            "maxzoom": 19,
            "layout": {"visibility": "none"},
            # No cross-fade (DIC-528): the default 300 ms fade makes aerial tiles shimmer
            # during the cinematic fly-around.
            "paint": {"raster-fade-duration": 0},
        },
        {
            "id": "parcels-fill",
            "type": "fill",
            "source": "parcels",
            "source-layer": "parcels",
            "paint": {
                "fill-color": "#FDF6E3",
                "fill-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.45, 14, 0.5, 17, 0.55],
            },
        },
        {
            "id": "parcels-line",
            "type": "line",
            "source": "parcels",
            "source-layer": "parcels",
            "paint": {
                "line-color": "#374151",  # light-basemap default; the viewer adapts it
                "line-opacity": 0.85,
                "line-width": [
                    "interpolate",
                    ["linear"],
                    ["zoom"],
                    11,
                    0.3,
                    14,
                    0.6,
                    17,
                    1.2,
                    19,
                    2,
                ],
            },
        },
        {
            "id": "parcels-hover",
            "type": "line",
            "source": "parcels",
            "source-layer": "parcels",
            "paint": {"line-color": "#111827", "line-width": 2, "line-opacity": 0.9},
            "filter": ["==", ["get", "pin"], ""],
        },
        {
            "id": "parcels-selected-fill",
            "type": "fill",
            "source": "parcels",
            "source-layer": "parcels",
            "paint": {"fill-color": "#ffffff", "fill-opacity": 0.18},
            "filter": ["==", ["get", "pin"], ""],
        },
        {
            "id": "parcels-selected-line",
            "type": "line",
            "source": "parcels",
            "source-layer": "parcels",
            "paint": {"line-color": "#0b1220", "line-width": 3, "line-opacity": 1},
            "filter": ["==", ["get", "pin"], ""],
        },
        {
            # Legacy auto-PIN label, hidden (DIC-504): kept only as a stable insertion
            # anchor for map.js (`before: "parcels-labels"`).
            "id": "parcels-labels",
            "type": "symbol",
            "source": "parcels",
            "source-layer": "parcels",
            "minzoom": 15,
            "layout": {
                "visibility": "none",
                "text-field": ["get", "pin"],
                "text-font": ["Noto Sans Regular"],
                "text-size": ["interpolate", ["linear"], ["zoom"], 15, 9, 17, 12, 19, 14],
                "text-allow-overlap": False,
                "text-padding": 2,
                "symbol-placement": "point",
            },
            "paint": {
                "text-color": "#1f2937",
                "text-halo-color": "#ffffff",
                "text-halo-width": 1.4,
                "text-halo-blur": 0.4,
            },
        },
    ],
}
