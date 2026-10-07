# 16. MCP server: a plain Django view with question-sized tools, metered per key

## Status

Proposed (DIC-2201, 2026-10-07). How it's served is agreed. The tool list is a draft for the team; the full inputs and outputs of each tool are in DIC-2201. Builds on ADR 0015.

## Context

ADR 0015 lets visitors' own AI assistants (Claude, ChatGPT, …) use the Parcel Viewer through an official MCP server, with each connection metered by its own key instead of by address. Assistants call from their providers' shared servers, so per-address budgets would make every user of one assistant share a single budget.

Three things shape the server:
- **The data stays question-sized.** An assistant must not become a bulk channel, so the tools have to answer questions, never page through the county.
- **The API is synchronous.** The Django API runs under gunicorn with `config.wsgi:application`, 2 workers × 4 threads (`api/Dockerfile`). `config/asgi.py` is Django's default file and isn't used.
- **The official library is async.** The Python MCP library serves an async (ASGI) app, so it can't be mounted inside this Django app as it runs today.

There's no sales data in the API, so the tools cover ownership, assessed and taxable value, class, acreage, districts and geography.

## Decision

- **`/mcp` is an ordinary Django view.**
  - It uses the MCP spec's stateless mode: each request is one JSON POST answered with one JSON response, with no streaming and no server-side sessions.
  - Read-only tools need only three messages: `initialize`, `tools/list` and `tools/call`.
  - It runs on the existing gunicorn workers, so metering (`access.meter`), county settings and logging apply as they do for the viewer. There's nothing new to deploy.
- **Seven tools, all read-only,** each taking an optional `county` (the deployment's by default):

  | Tool | Answers | Budget charge |
  |---|---|---|
  | `list_counties` | Counties available, data currency, terms | 0 |
  | `search_parcels` | Address, PIN or owner search, at most 10 results | 1 per result |
  | `get_parcel` | One parcel's full record, with no polygon | 1 |
  | `compare_parcels` | 2–5 parcels side by side | 1 per parcel |
  | `area_stats` | Aggregates for a buffer, named area or drawn polygon | 0 |
  | `list_areas` | Names of townships, subdivisions, sections, school districts | 0 |
  | `describe_location` | Township, section, subdivision, school district, nearest address and road | 0 |

- **No tool lists or exports many records.** The map-area, cohort and CSV routes have no MCP equivalent, search is capped at 10 results, and parcel polygons and tiles aren't served. Each answer links to the viewer (`viewer_url`) for the map.
- **Aggregates need at least 10 parcels.** `area_stats` over a handful of parcels would nearly give out their records, so smaller areas are refused with a pointer to `get_parcel`. Its owner statistics are counts and shares, never names.
- **The same budget and the same gentle degrade as the viewer.** Past the budget, results keep their public fields, leave out the detail fields (`DETAIL_FIELDS`) and say so (`details_withheld`, with the county's data link). Every response carries `detail_budget`, `roll_year`, and a source and terms line. Errors name the next step instead of returning a bare 4xx.
- **Each connection signs in with OAuth.** MCP's authorization needs its own endpoints (server metadata, client registration, tokens), for example through `django-oauth-toolkit`. That gives each connection its own key for metering.

### Considered and not chosen

- **A separate MCP service** using the official library under uvicorn. It would be one more container, and metering would have to be wired into a second process.
- **Switching Django to ASGI.** That would change how the whole API is served for one endpoint, and the synchronous database code would pay for thread handoffs on every request.

## Consequences

- **We implement the protocol ourselves.** It's a small JSON-RPC surface, but MCP spec changes are ours to follow. If streaming or server-to-client messages are needed later, revisit a separate service.
- **Area statistics need server-side code.** The aggregation runs only in the browser today (`engine/capabilities/cohort-analyze.core.js`). It gets a Python port with a parity test against the JS core.
- **MCP traffic shares the API's capacity:** 8 requests at a time. Tool calls are short; if MCP use grows, add workers or threads.
- **The tool list is the public contract.** Renaming a tool or changing its fields breaks assistants that already use it, so changes after launch are additive.
- **Still open:** whether the boundary history (`/parcel/<id>/history`) is a tool of its own or part of `get_parcel`, and whether 10 is the right minimum for `area_stats`.
