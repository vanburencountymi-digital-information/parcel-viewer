"""Reads Content-Security-Policy violation reports into short, log-safe summaries (DIC-2556).

Browsers send reports two ways, both to POST /csp-report (nginx: /api/csp-report):

- the legacy `report-uri` format: Content-Type application/csp-report, one report as
  {"csp-report": {"document-uri": ..., "effective-directive": ..., "blocked-uri": ...}};
- the Reporting API (`report-to` + Reporting-Endpoints; not in the policy yet, see
  infra/nginx.viewer.conf): Content-Type
  application/reports+json, a list of {"type": "csp-violation", "body": {"documentURL":
  ..., "effectiveDirective": ..., "blockedURL": ...}}, possibly batched with other types.

A summary keeps what locating a violation needs and nothing that could carry personal data
(ADR 0001): URLs lose their query string and fragment (search terms can be owner names),
and the script sample, referrer and full policy are dropped.
"""

import json
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from common.logging_setup import safe_for_log

LEGACY_TYPE = "application/csp-report"
REPORTING_TYPE = "application/reports+json"
ACCEPTED_TYPES = {LEGACY_TYPE, REPORTING_TYPE, "application/json"}

# A batch from the Reporting API holds a page's reports from the last few seconds; more
# than this many violations in one post are dropped, not logged.
MAX_REPORTS_PER_POST = 20


class BadReport(ValueError):
    """The body isn't a CSP report in either format."""


@dataclass(frozen=True)
class Violation:
    directive: str
    blocked: str
    document: str
    source: str
    line: str
    column: str
    disposition: str


def _without_query(value: Any, max_len: int = 300) -> str:
    """Takes a URL (or a CSP keyword such as "inline" or "eval"). Returns it without its
    query string and fragment, as one log-safe line."""
    text = str(value or "")
    if "://" in text:
        parts = urlsplit(text)
        text = f"{parts.scheme}://{parts.netloc}{parts.path}"
    else:
        text = text.split("?", 1)[0].split("#", 1)[0]
    return safe_for_log(text, max_len)


def _path_only(value: Any) -> str:
    """Takes the document URL. Returns just its path: the origin is always ours."""
    text = str(value or "")
    return safe_for_log(urlsplit(text).path if "://" in text else _without_query(text), 300)


def _number(value: Any) -> str:
    return str(value) if isinstance(value, int) and not isinstance(value, bool) else ""


def _violation(body: dict[str, Any], legacy: bool) -> Violation:
    def field(legacy_name: str, reporting_name: str) -> Any:
        return body.get(legacy_name if legacy else reporting_name)

    # Older browsers fill only violated-directive, which may carry the source list too.
    directive = (
        field("effective-directive", "effectiveDirective")
        or str(field("violated-directive", "violatedDirective") or "").split(" ", 1)[0]
    )
    return Violation(
        directive=safe_for_log(directive, 40),
        blocked=_without_query(field("blocked-uri", "blockedURL"), 200),
        document=_path_only(field("document-uri", "documentURL")),
        source=_without_query(field("source-file", "sourceFile")),
        line=_number(field("line-number", "lineNumber")),
        column=_number(field("column-number", "columnNumber")),
        disposition=safe_for_log(field("disposition", "disposition") or "", 12),
    )


def parse_reports(raw: bytes, content_type: str) -> list[Violation]:
    """
    Takes the request body and its media type (lower case, no parameters). Returns its CSP
    violations, at most MAX_REPORTS_PER_POST. Raises BadReport when the body is neither format.
    """
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BadReport("not JSON") from exc
    if content_type != REPORTING_TYPE and isinstance(data, dict):
        report = data.get("csp-report")
        if not isinstance(report, dict):
            raise BadReport("no csp-report object")
        return [_violation(report, legacy=True)]
    if isinstance(data, list):
        bodies = [
            r["body"]
            for r in data
            if isinstance(r, dict)
            and r.get("type") == "csp-violation"
            and isinstance(r.get("body"), dict)
        ]
        return [_violation(b, legacy=False) for b in bodies[:MAX_REPORTS_PER_POST]]
    raise BadReport("neither a csp-report object nor a list of reports")
