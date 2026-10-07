"""Root URL configuration. Routes keep the FastAPI paths, without trailing slashes (ADR 0011)."""

from django.contrib import admin
from django.urls import include, path

from common.docs import StaffSchemaView, StaffSwaggerView

# The Django admin is the staff config editor (DIC-2151); "View site" opens the viewer.
admin.site.site_header = "Parcel viewer admin"
admin.site.site_title = "Parcel viewer admin"
admin.site.site_url = "/demo/"

urlpatterns = [
    path("", include("common.urls")),
    path("", include("parcels.urls")),
    path("", include("county_config.urls")),
    path("", include("wms.urls")),
    path("", include("feedback.urls")),
    path("", include("accounts.urls")),
    path("django-admin/", admin.site.urls),
    # Staff only, and a 404 for everyone else (ADR 0009, common.docs).
    path("schema", StaffSchemaView.as_view(), name="schema"),
    path("docs", StaffSwaggerView.as_view(url_name="schema"), name="docs"),
]

# An unknown path and an unhandled error answer as FastAPI did (common.exceptions).
handler404 = "common.exceptions.not_found"
handler500 = "common.exceptions.server_error"
