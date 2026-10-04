# 2. Automatic semantic versioning via Conventional Commits

## Status

Accepted (DIC-1881). Same approach as the team's dice-document-pipeline-api ADR 0012.

## Context

There were no releases or tags. A deployed image couldn't say which code it was running, Sentry couldn't tell which release an error came from, and rolling back meant finding a commit by hand. The team standard (*Auto-versioning and Semantic Release*) is automatic versioning from commit messages.

## Decision

- **Commit messages follow Conventional Commits**:
  - `fix:` → patch;
  - `feat:` → minor;
  - `feat!:` or `BREAKING CHANGE:` → major;
  - `docs:` / `test:` / `ci:` / `chore:` / `refactor:` / `style:` → no release.

  A `conventional-pre-commit` hook enforces the format at commit time.
- **`.github/workflows/release.yml` runs `python-semantic-release`** on every push to `main`, and pushes a `vX.Y.Z` tag and GitHub Release.
  - It authenticates as the org's **VBCD Semantic Release App**, a ruleset bypass actor, since `main` requires PRs for everyone.
  - Until the app is installed and its secrets exist, the job skips with a notice rather than failing.
- **The tag is the only source of the version.** `[tool.semantic_release]` sets no `version_toml` / `version_variables`, so no file is rewritten.
- **The running apps learn the version at build time.** The build argument `APP_VERSION` (from `git describe --tags`, with the leading `v` stripped) is baked in as an environment variable. It's reported as the API version and the Sentry release.
  - `map-buddy/deploy.sh` does this automatically.
  - Compose builds take it from the environment.
  - `0.0.0` means an untagged local build.

## Consequences

- Almost every merge to `main` bumps the version, which is fine because it costs nothing.
- To answer "what version is this?", run `git describe --tags`, or ask the running app (Map Buddy `/status`). No file in the repo says.
- **Admin steps are needed before the first release:**
  - install the VBCD Semantic Release App on this repo;
  - add `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`;
  - add the app to the `main` ruleset's bypass list.
- The first release is computed from the whole history, since there are no tags yet.
