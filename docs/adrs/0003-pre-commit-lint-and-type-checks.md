# 3. Pre-commit: ruff, mypy, gitleaks

## Status

Accepted (DIC-1881)

## Context

The Python code had no linter, formatter or type checker, and nothing stopped a secret from being committed to this public repo. The team standard (*Suggested Architecture Boilerplate*, *"Production" App Checklist*) is pre-commit hooks with ruff and mypy, run again in CI.

## Decision

- **`.pre-commit-config.yaml`**, matching the team repos:
  - conventional commit messages;
  - file hygiene;
  - **ruff** (lint + format, settings as in the boilerplate);
  - **mypy**;
  - plus **gitleaks** (team GitLeaks guidance).
- **CI runs the same hooks** on every PR and push to `main` (`.github/workflows/lint.yml`).
- **Settings live in one root `pyproject.toml`.** mypy checks both services in one run. Their module names don't collide: the API's are `app.*` / `parcel_viewer.*`, Map Buddy's are top-level.
- **mypy is strict** (`disallow_untyped_defs`), with two exemptions:
  - Modules written before type checking are listed in an override that doesn't yet require every function to be annotated. They're still type-checked. New modules get no exemption, and entries come off the list as modules gain annotations.
  - Tests are exempt, as in the boilerplate.
- **Adoption was a one-time pass:**
  - ruff formatting of 41 files;
  - 140 lint findings fixed, including `%`-formatting → f-strings (each conversion reviewed) and `raise … from`;
  - 82 type errors fixed.

  Most type errors had one cause: the DB pool wasn't typed as returning dict rows. None was a live bug.
- **No JavaScript linter.** The team standard names none. The JS is covered by the unit, contract and e2e suites.

## Consequences

- Every commit and PR is formatted, linted, type-checked and secret-scanned before review.
- **Contributors need a one-time `pre-commit install`** (see README → Contributing).
- The legacy-module exemption list is technical debt to pay down, not a permanent carve-out.
