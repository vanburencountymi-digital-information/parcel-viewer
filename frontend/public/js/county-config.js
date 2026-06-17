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
  },
};
