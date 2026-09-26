#!/usr/bin/env bash
# run-harness.sh — the ISV eval/test harness (A2), exactly as CI runs it
# (.github/workflows/isv-harness.yml, job "harness"). Zero third-party deps:
# Node's built-in test runner for the JS capability cores + the engine contract,
# and stdlib-only Python tests for the explainer contract, cohort SQL, quota, etc.
#
# Usage:  bash engine/run-harness.sh        (from anywhere in the repo)
#         PYTHON=python3.12 bash engine/run-harness.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

echo "== ISV harness: JS capability cores + contract (node --test) =="
node --test

echo
echo "== ISV harness: Python contract tests (stdlib only) =="
# Prefer a modern python (agent.py uses 3.10+ union syntax).
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3.12 python3.11 python3 python; do
    if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
  done
fi
"$PY" -VV
# Same list and invocation as CI. Each file runs directly: `python -m unittest test.<mod>`
# resolves `test` to the stdlib package, not engine/test/. Not listed (as in CI):
# run_parcel_store, run_knowledge_store and run_tenant_isolation need the ZIP backend
# from a sibling repo (../ZIP/zip-poc/backend).
for t in run_explain_contract run_cohort_query run_quota run_cost_cache run_citation_extract run_kb_resolver run_pv_parcel_store run_workflow_params; do
  echo "-- $t"
  "$PY" "test/${t}_test.py"
done

echo
echo "ISV harness: PASS"
