# Map vision evaluation results

Baselines for the opt-in live evaluations in this folder. Rerun after changing the vision
prompt, `VISION_MODEL`, `VISION_EFFORT`, or the look and offer rules, and add a row.

## Vision set (`python -m evals.vision_eval`, 21 cases over 17 views)

| Date | Model | Effort | Passed | Cost per look | Average time |
|---|---|---|---|---|---|
| 2026-10-05 | claude-opus-5-5 | default | 21/21* | $0.020 | 8.6 s |
| 2026-10-05 | claude-opus-5-5 | low | 21/21 | $0.018 | 7.5 s |
| 2026-10-05 | **claude-sonnet-5-5** | default | 21/21 | **$0.008** | **5.5 s** |

\* 19/21 as first scored. Both failures were the checker's fault, and the cases were fixed:
"no structures" was about the field across the road, and "corn" was named only to rule
it out.

**Decision (DIC-2138):** Sonnet 5.5 is the default `VISION_MODEL`. It matched Opus on
every case at less than half the cost, and was faster. On blurry imagery it was the more
explicit of the two ("the imagery is hazy"). Image input was about 1,870 tokens a look on
all three runs, and output was 480 to 630 tokens.

## Offer rules (`python -m evals.offer_eval`, 16 first-turn questions)

| Date | Chat model | Passed | False-offer rate | Unasked looks | Missed offers | Missed looks |
|---|---|---|---|---|---|---|
| 2026-10-05 | claude-sonnet-4-6 | 15/16 | 0% | 1 (pond) | 0 | 0 |
| 2026-10-05, after tuning (offer and look cases only) | claude-sonnet-4-6 | 7/7 | not rerun | 0 | 0 | 0 |

Tuning after the first run:
- "Is there a pond?" had triggered a look. The rules now say a question about what's on
  the land is not a request to look: check the data first, then offer.
- Offers are phrased as one natural question.
- Text from separate model calls in one turn is no longer run together.

The 9 data questions were not rerun after tuning, because the change only makes looking
stricter.

**Limits (DIC-2138):** each look counts as 1 quota unit (`VISION_QUOTA_UNITS`), since it
costs no more than a chat turn (about $0.02). Each client is allowed 10 looks an hour and
30 a day (`VISION_RATE_LIMIT`).
