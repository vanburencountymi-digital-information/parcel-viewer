# 6. Data access: unmanaged models, existing SQL first

## Status

Accepted (DIC-2148)

## Context

The parcel tables (`geo.*`, `assessing.vbc_parcels`) belong to another pipeline, which reloads them. Django mustn't create or alter them. The FastAPI routes use tuned spatial SQL (bbox queries with a 4,000 cap, cohort predicates, nearest-road snapping); rewriting it into the ORM is where ports slip.

## Decision

- **Unmanaged models** (`managed = False`) for the 7 tables the API reads, generated with `inspectdb` and tidied: singular names, schema-qualified `db_table`, real types where inspectdb guessed (e.g. `related_parcel_ids` is `integer[]`). Wide shapefile tables declare only the columns the API reads.
- **Phase 3 ports each route with its existing SQL first**, through a repository class (team standard: database access behind a repository). Queries move to the ORM only where it reads better and the contract diff stays empty.
- Columns keep their database names, so the SQL and the models agree.

## Consequences

- A column renamed by a reload breaks the API, as `full_address` → `fulladdr` did (DIC-2152). The models make the dependency visible. A schema check at deploy time (follow-up) would catch it before users do.
- No migrations are ever generated for `parcels`; the router forbids them.
