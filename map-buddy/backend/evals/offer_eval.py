"""Map vision offer-rule evaluation (DIC-2138): does Map Buddy offer or take a look only
when it should?

Sends each question in evals/offer_cases.json to the real chat model as the first turn of
a fresh conversation, then reads which vision commands came back. Costs a few cents per
run (chat model calls; no vision calls), so it is opt-in and never part of CI. From
map-buddy/backend, with ANTHROPIC_API_KEY set and the dev stack up for the data tools:

    PARCEL_API_BASE=http://localhost:8080/api python -m evals.offer_eval
    OFFER_EVAL_ONLY=barn,pond python -m evals.offer_eval   # a slice, after tuning

Prints each case, then the false-offer rate (an offer or look on a question the data
answers), missed offers, and unasked looks. Exits 1 if any case fails.
"""

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).parent

# What Map Buddy did about map vision in one turn.
NONE, OFFER, LOOK = "none", "offer", "look"


def vision_action(commands: list[dict]) -> str:
    types = [c.get("type") for c in commands]
    if "look_at_map" in types:
        return LOOK
    if "offer_map_look" in types:
        return OFFER
    return NONE


def summarize(results: list[tuple[str, str]]) -> dict:
    """results: (expected, actual) pairs → the rates that matter."""
    data_qs = [a for e, a in results if e == NONE]
    offer_qs = [a for e, a in results if e == OFFER]
    look_qs = [a for e, a in results if e == LOOK]
    return {
        "false_offer_rate": (sum(a != NONE for a in data_qs) / len(data_qs)) if data_qs else 0.0,
        "missed_offers": sum(a == NONE for a in offer_qs),
        "unasked_looks": sum(a == LOOK for a in offer_qs),
        "missed_looks": sum(a != LOOK for a in look_qs),
        "passed": sum(e == a for e, a in results),
        "total": len(results),
    }


def main() -> int:
    from agent import run_chat_stream
    from main import ParcelContext

    spec = json.loads((HERE / "offer_cases.json").read_text(encoding="utf-8"))
    # Optional: only these case ids (comma-separated), to rerun a slice after tuning.
    only = set(filter(None, os.getenv("OFFER_EVAL_ONLY", "").split(",")))
    if only:
        spec["cases"] = [c for c in spec["cases"] if c["id"] in only]
    parcel = ParcelContext(**spec["parcel"])
    results: list[tuple[str, str]] = []
    for case in spec["cases"]:
        events = list(run_chat_stream(case["message"], [], parcel, spec["map_state"]))
        done = next((e for e in events if e.get("type") == "done"), None)
        if done is None:
            actual = "error"
            reply = next((e.get("message", "") for e in events if e.get("type") == "error"), "")
        else:
            actual = vision_action(done.get("commands") or [])
            reply = done.get("response_text", "")
        ok = actual == case["expect"]
        results.append((case["expect"], actual))
        print(
            f"{'pass' if ok else 'FAIL'}  {case['id']:<16} expected={case['expect']:<5} got={actual}"
        )
        print(f"      Q: {case['message']}")
        print(f"      A: {reply[:300]}\n")
    s = summarize(results)
    print(
        f"{s['passed']}/{s['total']} passed · false-offer rate {s['false_offer_rate']:.0%} · "
        f"missed offers {s['missed_offers']} · unasked looks {s['unasked_looks']} · "
        f"missed looks {s['missed_looks']}"
    )
    return 0 if s["passed"] == s["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
