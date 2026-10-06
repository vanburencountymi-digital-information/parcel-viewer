"""Replay-and-diff harness for the parcel API contract (DIC-2147).

The GeoDjango port (DIC-2146) must answer every request exactly as the FastAPI backend
does. This tool replays one request catalogue (catalogue.json) and checks that:

    record  BASE         replay against one backend; write the response shapes to
                         snapshot/shapes.json (committed) and the full responses to
                         .out/<label>/ (git-ignored)
    check   BASE         replay and compare the shapes against snapshot/shapes.json
    diff    BASE_A BASE_B
                         replay against both backends, request by request, and compare
                         status, contract headers and full bodies

Shapes (keys, value types, status, headers), not values, are committed: the API reads a
live database whose assessing data changes, and this repository is public, so owner names
and addresses stay out of it. Full-body comparison happens in `diff`, which hits both
backends a moment apart against the same database.

Requests run one at a time with a short pause, to go easy on the shared database.
Standard library only, so it runs anywhere Python 3.12 does:

    python tools/api-contract/contract.py diff http://localhost:8080/api http://localhost:8001
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
CATALOGUE = HERE / "catalogue.json"
SHAPES = HERE / "snapshot" / "shapes.json"
OUT = HERE / ".out"

PAUSE_S = 0.15
TIMEOUT_S = 60

# Headers that are part of the contract. Everything else (Date, Server, x-request-id,
# Content-Length, Connection, ...) varies per request or per server and is ignored.
CONTRACT_HEADERS = (
    "content-type",
    "cache-control",
    "x-content-type-options",
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-allow-credentials",
    "access-control-max-age",
    "retry-after",
    "www-authenticate",
)

_REPEAT = re.compile(r"<<repeat:(.):(\d+)>>")


def _expand(value: Any) -> Any:
    """Expand <<repeat:CHAR:N>> placeholders in strings, recursively."""
    if isinstance(value, str):
        return _REPEAT.sub(lambda m: m.group(1) * int(m.group(2)), value)
    if isinstance(value, list):
        return [_expand(v) for v in value]
    if isinstance(value, dict):
        return {k: _expand(v) for k, v in value.items()}
    return value


def load_catalogue() -> list[dict[str, Any]]:
    requests: list[dict[str, Any]] = json.loads(CATALOGUE.read_text(encoding="utf-8"))["requests"]
    names = [r["name"] for r in requests]
    dupes = {n for n in names if names.count(n) > 1}
    if dupes:
        raise SystemExit(f"duplicate request names in catalogue: {sorted(dupes)}")
    return requests


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # a 3xx is a response
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def send(base: str, req: dict[str, Any]) -> dict[str, Any] | None:
    """Send one catalogue request. None when it needs a credential that isn't set."""
    headers = {"Accept": "application/json, */*"}
    headers.update(req.get("headers") or {})
    if req.get("auth") == "admin":
        token = os.getenv("PV_ADMIN_TOKEN", "")
        if not token:
            return None
        headers["X-Admin-Token"] = token
    data = None
    if "body" in req:
        data = json.dumps(_expand(req["body"])).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif "raw_body" in req:
        # Bytes exactly as written (malformed JSON, plain text), for the body-parsing cases.
        data = _expand(req["raw_body"]).encode("utf-8")
    if "content_type" in req:
        headers["Content-Type"] = req["content_type"]
    url = base.rstrip("/") + _expand(req["path"])
    request = urllib.request.Request(url, data=data, headers=headers, method=req["method"])
    started = time.perf_counter()
    try:
        with _opener.open(request, timeout=TIMEOUT_S) as resp:
            status, raw, resp_headers = resp.status, resp.read(), resp.headers
    except urllib.error.HTTPError as e:
        status, raw, resp_headers = e.code, e.read(), e.headers
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    lower = {k.lower(): v for k, v in resp_headers.items()}
    return {
        "status": status,
        "headers": {h: lower[h] for h in CONTRACT_HEADERS if h in lower},
        "body": _decode(raw, lower.get("content-type", "")),
        "ms": elapsed_ms,
    }


def _decode(raw: bytes, content_type: str) -> Any:
    base = content_type.split(";", 1)[0].strip().lower()
    if base.endswith("json"):
        try:
            return {"json": json.loads(raw)}
        except ValueError:
            pass
    if base.startswith("text/") or base.endswith(("javascript", "xml", "json")):
        return {"text": raw.decode("utf-8", errors="replace")}
    return {"bytes": len(raw)}


# ── Shapes ──────────────────────────────────────────────────────────────────


def shape(value: Any) -> Any:
    """A value's structure without its data: dict keys, value types, list element shapes.

    Numbers are one type ("number"); null is its own type, so a field that turns nullable
    shows up. A list's elements are merged into one shape (a key missing from some
    elements is marked optional), so the snapshot doesn't depend on how many rows the
    database returns today.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        if not value:
            return ["empty"]
        merged = shape(value[0])
        for item in value[1:]:
            merged = _merge(merged, shape(item))
        return [merged]
    if isinstance(value, dict):
        return {k: shape(v) for k, v in value.items()}
    return type(value).__name__


def _merge(a: Any, b: Any) -> Any:
    if a == b:
        return a
    if isinstance(a, dict) and isinstance(b, dict):
        out: dict[str, Any] = {}
        for key in list(a) + [k for k in b if k not in a]:
            if key in a and key in b:
                out[key] = _merge(a[key], b[key])
            else:
                out[key] = _merge(a.get(key, "missing"), b.get(key, "missing"))
        return out
    if isinstance(a, list) and isinstance(b, list):
        if a == ["empty"]:
            return b
        if b == ["empty"]:
            return a
        return [_merge(a[0], b[0])]
    left = set(a.split("|")) if isinstance(a, str) else {json.dumps(a, sort_keys=True)}
    right = set(b.split("|")) if isinstance(b, str) else {json.dumps(b, sort_keys=True)}
    return "|".join(sorted(left | right))


def response_shape(resp: dict[str, Any], compare: str) -> dict[str, Any]:
    out: dict[str, Any] = {"status": resp["status"]}
    if compare == "status":
        out["content-type"] = resp["headers"].get("content-type")
        return out
    out["headers"] = resp["headers"]
    body = resp["body"]
    if "json" in body:
        out["json"] = shape(body["json"])
    elif "text" in body:
        out["text"] = "string"
    else:
        out["bytes"] = "binary"
    return out


# ── Comparison ──────────────────────────────────────────────────────────────


def compare_values(a: Any, b: Any, path: str = "$") -> tuple[list[str], list[str]]:
    """(differences, warnings) between two decoded JSON values.

    Key order and int-vs-float spelling of the same number are warnings, not
    differences: JSON consumers don't depend on them, but they're worth knowing about.
    """
    diffs: list[str] = []
    warns: list[str] = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in a:
            if k not in b:
                diffs.append(f"{path}.{k}: missing in B")
        for k in b:
            if k not in a:
                diffs.append(f"{path}.{k}: only in B")
        for k in a:
            if k in b:
                d, w = compare_values(a[k], b[k], f"{path}.{k}")
                diffs += d
                warns += w
        common_a = [k for k in a if k in b]
        common_b = [k for k in b if k in a]
        if common_a != common_b:
            warns.append(f"{path}: key order differs")
        return diffs, warns
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            diffs.append(f"{path}: {len(a)} items in A, {len(b)} in B")
        if _keyed_by_id(a) and _keyed_by_id(b):
            # /parcels and /cohort have no ORDER BY: the same rows may come back in any
            # order, so match rows by id and only warn about order.
            if [x["id"] for x in a] != [y["id"] for y in b]:
                warns.append(f"{path}: same ids in a different order")
            a = sorted(a, key=lambda x: str(x["id"]))
            b = sorted(b, key=lambda x: str(x["id"]))
        for i, (x, y) in enumerate(zip(a, b, strict=False)):
            d, w = compare_values(x, y, f"{path}[{i}]")
            diffs += d
            warns += w
            if len(diffs) > 20:
                diffs.append(f"{path}: stopped after 20 differences")
                break
        return diffs, warns
    both_numbers = all(isinstance(v, int | float) and not isinstance(v, bool) for v in (a, b))
    if both_numbers:
        if a != b:
            diffs.append(f"{path}: {a!r} != {b!r}")
        elif type(a) is not type(b):
            warns.append(f"{path}: {a!r} vs {b!r} (int/float spelling)")
        return diffs, warns
    if a != b or type(a) is not type(b):
        diffs.append(f"{path}: {_short(a)} != {_short(b)}")
    return diffs, warns


def _counts(value: Any) -> Any:
    """The lengths of every list in a JSON value, keyed by where they are."""
    if isinstance(value, dict):
        return {k: _counts(v) for k, v in value.items() if isinstance(v, dict | list)}
    if isinstance(value, list):
        return len(value)
    return None


def _keyed_by_id(items: list[Any]) -> bool:
    return bool(items) and all(isinstance(x, dict) and "id" in x for x in items)


def _short(v: Any) -> str:
    s = json.dumps(v, default=str)
    return s if len(s) <= 80 else s[:77] + "..."


def compare_responses(
    a: dict[str, Any], b: dict[str, Any], compare: str
) -> tuple[list[str], list[str]]:
    diffs: list[str] = []
    warns: list[str] = []
    if a["status"] != b["status"]:
        diffs.append(f"status {a['status']} != {b['status']}")
    if compare == "status":
        ta, tb = a["headers"].get("content-type"), b["headers"].get("content-type")
        if ta != tb:
            diffs.append(f"content-type {ta!r} != {tb!r}")
        return diffs, warns
    for h in sorted(set(a["headers"]) | set(b["headers"])):
        if a["headers"].get(h) != b["headers"].get(h):
            diffs.append(f"header {h}: {a['headers'].get(h)!r} != {b['headers'].get(h)!r}")
    ba, bb = a["body"], b["body"]
    if compare == "shape" and "json" in ba and "json" in bb:
        # A truncated, unordered result: which rows come back is arbitrary, so compare
        # the row count and the structure, not the values.
        diffs += compare_values(_counts(ba["json"]), _counts(bb["json"]))[0]
        diffs += compare_values(shape(ba["json"]), shape(bb["json"]))[0]
    elif "json" in ba and "json" in bb:
        d, w = compare_values(ba["json"], bb["json"])
        diffs += d
        warns += w
    elif ba != bb:
        diffs.append(f"body differs ({sorted(ba)[0]} vs {sorted(bb)[0]})")
    return diffs, warns


# ── Commands ────────────────────────────────────────────────────────────────


def _label(base: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", base).strip("_")


def _replay(base: str, only: str | None) -> dict[str, dict[str, Any] | None]:
    results: dict[str, dict[str, Any] | None] = {}
    for req in load_catalogue():
        if only and not re.search(only, req["name"]):
            continue
        results[req["name"]] = send(base, req)
        time.sleep(PAUSE_S)
    return results


def cmd_record(base: str, only: str | None) -> int:
    catalogue = {r["name"]: r for r in load_catalogue()}
    results = _replay(base, only)
    out_dir = OUT / _label(base)
    out_dir.mkdir(parents=True, exist_ok=True)
    shapes = json.loads(SHAPES.read_text(encoding="utf-8")) if SHAPES.exists() else {}
    skipped = []
    for name, resp in results.items():
        if resp is None:
            skipped.append(name)
            continue
        (out_dir / f"{name}.json").write_text(json.dumps(resp, indent=2), encoding="utf-8")
        if catalogue[name].get("known_issue"):
            continue  # broken today: don't pin the broken response as the contract
        shapes[name] = response_shape(resp, catalogue[name].get("compare", "full"))
    shapes = {n: shapes[n] for n in catalogue if n in shapes}  # catalogue order, drop removed
    SHAPES.parent.mkdir(parents=True, exist_ok=True)
    SHAPES.write_text(json.dumps(shapes, indent=2) + "\n", encoding="utf-8")
    print(f"recorded {len(results) - len(skipped)} responses from {base}")
    print(f"  shapes -> {SHAPES.relative_to(HERE.parent.parent)}")
    print(f"  bodies -> {out_dir.relative_to(HERE.parent.parent)} (git-ignored)")
    if skipped:
        print(f"  skipped (PV_ADMIN_TOKEN not set): {', '.join(skipped)}")
    return 0


def cmd_check(base: str, only: str | None) -> int:
    catalogue = {r["name"]: r for r in load_catalogue()}
    expected = json.loads(SHAPES.read_text(encoding="utf-8"))
    failed = 0
    for name, resp in _replay(base, only).items():
        if resp is None:
            print(f"SKIP  {name} (PV_ADMIN_TOKEN not set)")
            continue
        if catalogue[name].get("known_issue"):
            print(f"KNOWN {name} ({catalogue[name]['known_issue']}): status {resp['status']}")
            continue
        if name not in expected:
            print(f"NEW   {name} (not in the snapshot; run record)")
            failed += 1
            continue
        got = response_shape(resp, catalogue[name].get("compare", "full"))
        diffs, _ = compare_values(expected[name], got)
        if diffs:
            failed += 1
            print(f"FAIL  {name}")
            for d in diffs:
                print(f"        {d}")
        else:
            print(f"ok    {name}")
    print(f"\n{failed} of the checked requests differ from the snapshot")
    return 1 if failed else 0


def cmd_diff(base_a: str, base_b: str, only: str | None) -> int:
    failed = 0
    warned = 0
    timings = []
    for req in load_catalogue():
        name = req["name"]
        if only and not re.search(only, name):
            continue
        a = send(base_a, req)
        b = send(base_b, req)
        time.sleep(PAUSE_S)
        if a is None or b is None:
            print(f"SKIP  {name} (PV_ADMIN_TOKEN not set)")
            continue
        timings.append((name, a["ms"], b["ms"]))
        diffs, warns = compare_responses(a, b, req.get("compare", "full"))
        if diffs and req.get("known_issue"):
            print(f"KNOWN {name} ({req['known_issue']}): status {a['status']} vs {b['status']}")
        elif diffs:
            failed += 1
            print(f"FAIL  {name}")
            for d in diffs:
                print(f"        {d}")
        else:
            print(f"ok    {name}")
        if warns:
            warned += 1
            for w in warns[:5]:
                print(f"  warn  {w}")
    slow = sorted(timings, key=lambda t: t[2] - t[1], reverse=True)[:5]
    print("\nslowest in B relative to A (ms):")
    for name, ms_a, ms_b in slow:
        print(f"  {name}: {ms_a} -> {ms_b}")
    print(f"\n{failed} requests differ, {warned} with warnings ({base_a} vs {base_b})")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("record", "check"):
        p = sub.add_parser(name)
        p.add_argument("base", help="API base URL, e.g. http://localhost:8080/api")
        p.add_argument("--only", help="regex on request names")
    p = sub.add_parser("diff")
    p.add_argument("base_a", help="reference API, e.g. http://localhost:8080/api")
    p.add_argument("base_b", help="API under test")
    p.add_argument("--only", help="regex on request names")
    args = parser.parse_args(argv)
    if args.cmd == "record":
        return cmd_record(args.base, args.only)
    if args.cmd == "check":
        return cmd_check(args.base, args.only)
    return cmd_diff(args.base_a, args.base_b, args.only)


if __name__ == "__main__":
    sys.exit(main())
