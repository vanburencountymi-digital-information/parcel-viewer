"""Public feedback endpoints — resident-submitted data-error reports.

Reports are emailed to the county GIS inbox (no database writes — the API runs
with a read-only DB role, and keeping a public, unauthenticated endpoint off the
primary database avoids adding a write surface). Email is sent via SMTP using
env-driven credentials (see parcel_viewer.config). When SMTP is unconfigured the
endpoint returns 503 "email_not_configured" and the UI shows a try-again state.
"""

import smtplib
from email.message import EmailMessage

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from parcel_viewer import config

router = APIRouter()


class DataErrorReport(BaseModel):
    pin: str | None = Field(default=None, max_length=64)
    details: str = Field(min_length=1, max_length=5000)
    email: str | None = Field(default=None, max_length=254)


def _send_email(report: DataErrorReport, user_agent: str) -> None:
    msg = EmailMessage()
    subject = "Parcel Viewer data-error report"
    if report.pin:
        subject += f" — {report.pin}"
    msg["Subject"] = subject
    msg["From"] = config.REPORT_FROM or config.SMTP_USER
    msg["To"] = config.REPORT_TO
    if report.email:
        msg["Reply-To"] = report.email
    msg.set_content(
        "A data-error report was submitted from the Parcel Viewer.\n\n"
        f"Parcel (PIN): {report.pin or '(not provided)'}\n"
        f"Reporter email: {report.email or '(not provided)'}\n\n"
        "Details:\n"
        f"{report.details}\n\n"
        "---\n"
        f"User agent: {user_agent}\n"
    )

    with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=15) as smtp:
        if config.SMTP_STARTTLS:
            smtp.starttls()
        if config.SMTP_USER and config.SMTP_PASSWORD:
            smtp.login(config.SMTP_USER, config.SMTP_PASSWORD)
        smtp.send_message(msg)


# Sync endpoint: FastAPI runs it in a threadpool, so the blocking SMTP call
# does not stall the event loop.
@router.post("/report-error")
def report_error(report: DataErrorReport, request: Request):
    """Email a resident-reported data error to the county GIS inbox."""
    if not config.SMTP_HOST:
        return JSONResponse({"ok": False, "error": "email_not_configured"}, status_code=503)
    try:
        ua = (request.headers.get("user-agent") or "")[:500]
        _send_email(report, ua)
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=502)
