/* County configuration manifest.
 *
 * Single source of truth for everything county-specific in the viewer. To stand
 * up the viewer for another county, edit THIS FILE — not the application code.
 * Consumers read from `window.COUNTY` with safe fallbacks, so a missing field
 * degrades gracefully rather than breaking the app.
 *
 * Loaded before map.js and the MapBuddy mount (see demo/index.html).
 *
 * Tiering note (future, see DIC-371 follow-ups):
 *   - labels.propClass is statewide-Michigan (same for every MI county).
 *   - labels.schoolDist and map.* are county-specific.
 *   - propClass / schoolDist should eventually come from the database.
 */
window.COUNTY = {
  name: "Van Buren County",
  state: "MI",

  // Initial map view + soft extent (used by initMap()).
  map: {
    extent: [[-86.33, 42.06], [-85.76, 42.43]],
    center: [-86.03, 42.24],
    zoom: 9,
  },

  // External destinations.
  forms: {
    dataRequest: "https://form.jotform.com/261544522974159",
  },
  endpoints: {
    // MapBuddy AI backend (Cloud Run). null → fall back to the mount default.
    mapBuddy: "https://map-buddy-toaozre74a-uc.a.run.app",
  },

  labels: {
    // Michigan STC property classification codes → human label (statewide MI).
    propClass: {
      "001":"Commercial – Personal Property", "002":"Industrial – Personal Property",
      "003":"Utility – Personal Property",    "004":"Agricultural – Personal Property",
      "005":"Residential – Personal Property","006":"Exempt – Personal Property",
      "007":"Other – Personal Property",
      "101":"Agricultural",                   "102":"Agricultural – Leased Federal/State",
      "110":"Agricultural – Other",           "111":"Agricultural – Timber Cutover",
      "120":"Agricultural – Vacant Land",
      "201":"Commercial",                     "202":"Commercial – Hotel / Motel",
      "203":"Commercial – Office",            "210":"Commercial – Other",
      "251":"Commercial – Rehabilitation",    "260":"Commercial – Special Acts",
      "301":"Industrial",                     "302":"Industrial – Leased Land",
      "310":"Industrial – Other",             "351":"Industrial – Rehabilitation",
      "401":"Residential",                    "402":"Residential – Condominium",
      "403":"Residential – Mobile Home",      "407":"Residential – Non-Homestead",
      "408":"Residential – Industrial Rehab", "410":"Residential – Personal Property",
      "501":"Timber-Cutover",                 "502":"Timber-Cutover – Leased",
      "551":"Timber-Cutover – Other",
      "601":"Developmental",
      "700":"Exempt",         "701":"Exempt – Publicly Owned",
      "702":"Exempt – Federal","703":"Exempt – State",
      "704":"Exempt – County","705":"Exempt – Local Government",
      "706":"Exempt – School","707":"Exempt – Church / Religious",
      "708":"Exempt – Charitable / Educational","709":"Exempt – Cemetery",
      "710":"Exempt – Hospital / Medical",
    },

    // Michigan school district codes → district name (Van Buren County + adjacent).
    schoolDist: {
      "80010":"South Haven Public Schools",   "80020":"Bangor Public Schools",
      "80040":"Covert Public Schools",        "80050":"Decatur Public Schools",
      "80090":"Bloomingdale Public Schools",  "80110":"Gobles Public Schools",
      "80120":"Hartford Public Schools",      "80130":"Lawrence Public Schools",
      "80140":"Lawton Community Schools",     "80150":"Mattawan Consolidated Schools",
      "80160":"Paw Paw Public Schools",       "80240":"Van Buren ISD",
      "03020":"Allegan County District",
      "11320":"Cass County District",         "11330":"Cass County District",
      "14020":"Watervliet Public Schools",    "14050":"Berrien County District",
    },
  },

  // Styling defaults (DIC-460). Models the viewer's current look as data; the
  // admin console reads this. NOTE: the viewer still applies most of these from
  // hardcoded JS/CSS today — wiring it to *consume* this block is the follow-on.
  styling: {
    colorScheme: "terracotta",        // default scheme (users can switch in Settings)
    schemes: [
      { id: "terracotta", label: "Terracotta", accent: "#A3473B", interactive: "#B58D4A" },
      { id: "forest",     label: "Forest",     accent: "#2F6B4F", interactive: "#4E9A6B" },
      { id: "ocean",      label: "Ocean",      accent: "#1F5E80", interactive: "#2E76A6" },
      { id: "slate",      label: "Slate",      accent: "#475569", interactive: "#64748B" },
      { id: "plum",       label: "Plum",       accent: "#7A3B6B", interactive: "#9D5A8C" },
      { id: "crimson",    label: "Crimson",    accent: "#B11E2F", interactive: "#C0392C" },
    ],
    theme: "light",                   // default theme
    basemap: "parcels",               // 'parcels' | 'aerial'
    parcels: {
      light: { fill: "#FDF6E3", stroke: "#8a7a55" },
      dark:  { fill: "#1e1a14", stroke: "#b8a97a" },
    },
    labels: {
      defaultField: "owner",
      fields: ["owner", "pin", "address", "acres", "av", "tv", "class"],
      defaultSize: "medium",
      sizes: ["small", "medium", "large"],
      zoom: { largeParcels: 13, smallParcels: 14 },
    },

    // Choropleth — color parcels by a tile attribute (DIC-460). Dormant by
    // default (enabled:false → solid parcel fill above is used). The viewer
    // builds a MapLibre fill expression from this and shows a legend.
    //   mode 'categorical': ["match"] over `categories` (value→color).
    //   mode 'graduated':   ["step"] over `stops` (>= min → color).
    //   transform 'classGroup': key on the FIRST digit of prop_class so the
    //   Michigan major class (1xx Ag, 2xx Commercial, …) drives the color.
    // Attributes available on the parcel tiles: prop_class, gis_acres,
    // municipality, owner_name, parcel_no (NOT av/tv — those aren't in the
    // tiles yet; needs the geo.parcel_tiles function to expose them).
    choropleth: {
      enabled: false,
      attribute: "prop_class",
      mode: "categorical",
      transform: "classGroup",
      fallback: "#d9d2c5",
      categories: [
        { value: "1", label: "Agricultural",  color: "#7CB342" },
        { value: "2", label: "Commercial",    color: "#FB8C00" },
        { value: "3", label: "Industrial",    color: "#8E24AA" },
        { value: "4", label: "Residential",   color: "#1E88E5" },
        { value: "5", label: "Ag / Timber",   color: "#558B2F" },
        { value: "6", label: "Developmental", color: "#00897B" },
        { value: "7", label: "Exempt",        color: "#9E9E9E" },
      ],
      // Used when mode === 'graduated' (e.g. attribute:'gis_acres', transform:null).
      stops: [
        { min: 0,   label: "< 5 ac",     color: "#fee5d9" },
        { min: 5,   label: "5–40 ac",    color: "#fcae91" },
        { min: 40,  label: "40–160 ac",  color: "#fb6a4a" },
        { min: 160, label: "160–640 ac", color: "#de2d26" },
        { min: 640, label: "≥ 640 ac",   color: "#a50f15" },
      ],
    },
  },

  // Layers & data (DIC-461). Base layers, tile server, and the overlay registry —
  // currently hardcoded in demo/index.html; modeled here as data for the console.
  layers: {
    tileServer: { provider: "Martin", url: "/tiles" },
    baseLayers: [
      { id: "parcels", label: "Parcels", source: "County PostGIS (vector tiles via Martin)", default: true },
      { id: "aerial", label: "Aerial imagery", source: "County / state imagery", default: false },
    ],
    overlays: [
      { id: "wetlands",   label: "Wetlands",         type: "WMS",    source: "USFWS National Wetlands Inventory", minZoom: 12 },
      { id: "flood",      label: "Flood hazard",     type: "WMS",    source: "FEMA NFHL",                          minZoom: 0 },
      { id: "soils",      label: "Soils",            type: "WMS",    source: "USDA SSURGO",                        minZoom: 0 },
      { id: "hillshade",  label: "Hillshade",        type: "raster", source: "USGS 3DEP",                          minZoom: 0 },
      { id: "contours10", label: "Contours (10 ft)", type: "raster", source: "USGS 3DEP",                          minZoom: 13 },
      { id: "contours5",  label: "Contours (5 ft)",  type: "raster", source: "USGS 3DEP",                          minZoom: 14 },
      { id: "contours2",  label: "Contours (2 ft)",  type: "raster", source: "USGS 3DEP",                          minZoom: 15 },
    ],
    dataSources: [
      { id: "parcels", label: "Parcel geometry", source: "geo.parcels (PostGIS)" },
      { id: "assessing", label: "Assessing / tax roll", source: "assessing.vbc_parcels" },
    ],
  },

  // Access & ops (DIC-462). County-level access + operational facts.
  access: {
    model: "Public — no sign-in",
    assessmentDataPublic: true,
    reportTo: "gis@vanburencountymi.gov",
    rateLimited: true,
  },
};
