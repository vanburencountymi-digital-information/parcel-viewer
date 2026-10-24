from django.urls import path

from feedback import views

urlpatterns = [
    path("report-error", views.ReportErrorView.as_view(), name="report-error"),
    path("client-errors", views.ClientErrorView.as_view(), name="client-errors"),
    path("csp-report", views.CspReportView.as_view(), name="csp-report"),
]
