"""Map vision evaluation (DIC-2135): run the saved map views through the real model.

Calls the model once per case (about 2 cents each on Claude Opus 5.5), so it is opt-in
and never part of CI. From map-buddy/backend, with ANTHROPIC_API_KEY set:

    python -m evals.vision_eval                    # all cases, current VISION_MODEL/EFFORT
    VISION_EFFORT=low python -m evals.vision_eval  # compare an effort level
    VISION_MODEL=claude-sonnet-5-5 python -m evals.vision_eval

Prints each case's verdict, the description, and token use, then a summary. Exits 1 if
any case fails its checks (see evals/vision/cases.json for the format).
"""

import json
import sys
import time
from pathlib import Path
from typing import Any

import vision

HERE = Path(__file__).parent / "vision"

# USD per million tokens (input, output), for the run's cost estimate. Check current
# prices before relying on these: https://www.anthropic.com/pricing
PRICES = {
    "claude-opus-5-5": (4.00, 20.00),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-haiku-4-5": (1.00, 5.00),
}


def estimate_usd(model: str, tokens_in: int, tokens_out: int) -> float | None:
    price = PRICES.get(model)
    if price is None:
        return None
    return (tokens_in * price[0] + tokens_out * price[1]) / 1_000_000


def check(description: str, case: dict) -> list[str]:
    """The case's failed checks, empty when it passes."""
    text = description.lower()
    problems = []
    for group in case.get("expect_any", []):
        if not any(word.lower() in text for word in group):
            problems.append("missing any of: " + ", ".join(group))
    for word in case.get("forbid", []):
        if word.lower() in text:
            problems.append("contains: " + word)
    return problems


def main() -> int:
    cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))["cases"]
    usage: list[tuple[int, int]] = []
    vision_create = vision._create_message

    def counting(purpose: str, **kwargs: Any) -> Any:
        response = vision_create(purpose, **kwargs)
        u = getattr(response, "usage", None)
        usage.append((getattr(u, "input_tokens", 0) or 0, getattr(u, "output_tokens", 0) or 0))
        return response

    vision._create_message = counting
    failed = 0
    print(f"model={vision.VISION_MODEL} effort={vision.VISION_EFFORT or 'default'}\n")
    for case in cases:
        image = (HERE / case["image"]).read_bytes()
        started = time.perf_counter()
        try:
            result = vision.run_describe_view(
                image,
                "image/jpeg",
                question=case.get("question"),
                parcel=case.get("parcel"),
                layers=case.get("layers"),
                view_width_ft=case.get("view_width_ft"),
            )
            problems = check(result["description"], case)
            description = result["description"]
        except vision.VisionRefused as e:
            problems, description = [f"refused: {e}"], ""
        seconds = time.perf_counter() - started
        tokens_in, tokens_out = usage[-1] if usage else (0, 0)
        failed += bool(problems)
        print(
            f"{'FAIL' if problems else 'pass'}  {case['id']}  ({seconds:.1f}s, in={tokens_in} out={tokens_out})"
        )
        for p in problems:
            print(f"      - {p}")
        print(f"      {description}\n")
    total_in = sum(i for i, _ in usage)
    total_out = sum(o for _, o in usage)
    usd = estimate_usd(vision.VISION_MODEL, total_in, total_out)
    cost = f", about ${usd:.2f} (${usd / max(1, len(usage)):.3f} a look)" if usd is not None else ""
    print(f"{len(cases) - failed}/{len(cases)} passed; tokens in={total_in} out={total_out}{cost}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
