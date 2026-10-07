# 15. Per-county data access: meter parcel details, don't strip them

## Status

Accepted (DIC-2196, Jerry, 2026-10-07). Built in the Django API behind a per-county setting; ships with the cutover (DIC-2150).

## Context

Van Buren and St. Joseph publish their parcel data for free. Many counties we'd like to add sell theirs, and the most common reason they give is that data created with public funds shouldn't be resold for profit by others. To them, the valuable product is the **joined layer**: parcel shapes plus owner and valuation. Their visitors must stay **anonymous**, and Michigan assessing data is generally a FOIA public record, so the aim is not to withhold records. It is to stop the viewer being a **free bulk channel**.

What the public viewer allows today (survey, 2026-10-07):

| Path | What it returns | Whole county |
|---|---|---|
| `POST /cohort` | 5,000 rows per request with owner and AV/TV | 10–20 requests |
| `GET /parcels?bbox=` | 4,000 parcels per request with geometry, owner and AV/TV | 20–30 requests |
| `GET /parcel/<id>` | sequential ids; owner mailing address, value history, legal description | about 40 minutes |
| Parcel tiles | carry owner names | about a minute |

Production (FastAPI) has only nginx's per-IP rate limits, with no daily cap and no logging of what was asked for.

Esri's parcel viewers can be locked down with field-limited views, export switches and query caps, but only if each county configures them. Their REST query endpoints are commonly dumped by paging. No platform can stop someone clicking through parcels by hand, or a patient scraper spread across many addresses. The realistic goals are:
- never send more than the screen needs;
- make bulk collection slow, capped and visible;
- let each county choose its level.

**Constraints from Jerry:**
- No heavy protection tools that slow the app or development.
- Keep every current feature, or improve it.
- Let visitors' own AIs use the viewer, without farming the data.

## Decision

- **A per-county setting, `access.mode`:**
  - `open`: today's behaviour, for Van Buren and St. Joseph;
  - `protected`: for counties that sell their data.
- **Meter details, don't strip them.** Removing owner/value fields from the bulk responses would break selection filters, CSV contents, owner labels and the value maps. Instead, every route keeps its fields, and each client has a **daily budget of detailed parcel records**: rows carrying owner or valuation fields.
  - The budget counts **records sent, not requests**, across all routes.
  - Protected default: **5,000 per client per day**, set per county.
  - A person exploring a neighbourhood never reaches it. A scraper walking a 50,000-parcel county does on day one.
- **Past the budget, degrade gently, never fail.**
  - Responses keep shapes, styling fields, search and public fields, but leave out owner/value fields.
  - They add `details_withheld: true` and a `detail_budget` block (limit, used, reset time, the county's data or contact link).
  - The viewer shows a short notice in place of the withheld fields.
  - No 4xx, so no feature breaks, and resellers are pointed at the county's paid channel.
- **Client identity:**
  - anonymous visitors: their address (`X-Real-IP`);
  - signed-in staff: unlimited;
  - API keys: per key.
- **AI access is per key, never per IP.** AI assistants call from their providers' shared servers, so per-IP budgets would make every user of an assistant share one. An official **MCP server** (DIC-2201) gives each connection a free key or OAuth sign-in.
  - Its tools answer questions: search, one parcel, area statistics, a small compare, nearby features.
  - There's no list-everything tool, and the same budget applies.
- **Light companion safeguards for Protected counties:**
  - parcel tiles without owner names (DIC-2199);
  - parcel ids that can't be walked in sequence (DIC-2200);
  - a terms-of-use / license notice in the viewer and in responses;
  - logging and alerts when a client crosses 50%/100% of its budget, plus a daily top-clients summary.
- **The counter is a small Postgres table** (`client, county, day, count`), with one atomic upsert per response. No Redis.
- **Not built:** CAPTCHAs (hurt anonymous and accessible use), browser fingerprinting, encrypting or obfuscating tiles. All cost speed and development time and are easy to get around.
- **Heavier options, only for counties that ask:**
  - an edge bot-management layer (CDN/WAF, infrastructure);
  - optional free sign-in with a larger budget;
  - coarser public geometry;
  - "canary" records that prove the source of a resold copy (a county-counsel call, since it alters published data).

## Consequences

- Open counties see no change. The contract harness must still show no difference against today, apart from the new budget headers.
- Protected counties keep every feature for normal use. Anonymous power users doing county-wide analysis in one day reach the budget and are shown the county's data link.
- Several people behind one address (an office, a library) share a budget. Staff sign in; a county can raise its budget.
- The enforcement lives in the Django API, so production gets it with the cutover. The FastAPI path doesn't.
- Parcel ids change shape for Protected counties (DIC-2200). Bookmarks and share links need a mapping during the transition.
- **New counties get a clear answer to "won't this give away our data?":** a Protected mode, the same daily budget for AI connections, and logs that show who is taking what.
