"""Data-error reports, emailed to the county GIS inbox (ported from backend/parcel_viewer/routers/feedback.py).

No database writes: a public, unauthenticated endpoint stays off the database. SMTP
settings come from the environment (PV_SMTP_*); without PV_SMTP_HOST the route answers
503 "email_not_configured" and the viewer shows a try-again state.
"""

import smtplib
from email.message import EmailMessage

from django.conf import settings

from feedback.params import DataErrorReport

SUBJECT = "Parcel Viewer data-error report"
SMTP_TIMEOUT_S = 15


def build_message(report: DataErrorReport, user_agent: str) -> EmailMessage:
    """Takes a report and the browser's user agent. Returns the email to the GIS inbox."""
    message = EmailMessage()
    message["Subject"] = f"{SUBJECT} — {report.pin}" if report.pin else SUBJECT
    message["From"] = settings.REPORT_FROM or settings.SMTP_USER
    message["To"] = settings.REPORT_TO
    if report.email:
        message["Reply-To"] = report.email
    message.set_content(
        "A data-error report was submitted from the Parcel Viewer.\n\n"
        f"Parcel (PIN): {report.pin or '(not provided)'}\n"
        f"Reporter email: {report.email or '(not provided)'}\n\n"
        "Details:\n"
        f"{report.details}\n\n"
        "---\n"
        f"User agent: {user_agent}\n"
    )
    return message


def send_report(report: DataErrorReport, user_agent: str) -> None:
    """Takes a report and the user agent. Sends the email; raises if SMTP fails."""
    message = build_message(report, user_agent)
    with smtplib.SMTP(settings.SMTP_HOST, int(settings.SMTP_PORT), timeout=SMTP_TIMEOUT_S) as smtp:
        if settings.SMTP_STARTTLS:
            smtp.starttls()
        if settings.SMTP_USER and settings.SMTP_PASSWORD:
            smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        smtp.send_message(message)
