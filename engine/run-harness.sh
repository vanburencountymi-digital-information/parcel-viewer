#!/usr/bin/env bash
# run-harness.sh — the full ISV eval/test harness (A2). Zero third-party deps:
# Node's built-in test runner for the JS capability cores + the engine contract,
# and stdlib unittest for the Python run_explain structured-output contract.
#
# Usage:  bash engine/run-harness.sh        (from the parcel-viewer repo root or engine/)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

echo "== ISV harness: JS capability cores + contract (node --test) =="
node --test

echo
echo "== ISV harness: Python explainer contract + KnowledgeStore seam (unittest) =="
# Prefer a modern python (agent.py uses 3.10+ union syntax).
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3.12 python3.11 python3 python; do
    if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
  done
fi
"$PY" -m unittest test.run_explain_contract_test test.run_knowledge_store_test test.run_parcel_store_test test.run_pv_parcel_store_test test.run_tenant_isolation_test test.run_cost_cache_test test.run_quota_test -v

echo
echo "ISV harness: PASS"
