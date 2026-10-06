"""Root URL configuration. Routes keep the FastAPI paths, without trailing slashes (ADR 0011)."""

from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

urlpatterns = [
    path("", include("common.urls")),
    path("", include("parcels.urls")),
    path("django-admin/", admin.site.urls),
    # Staff only (ADR 0009); SPECTACULAR_SETTINGS["SERVE_PERMISSIONS"] enforces it.
    path("schema", SpectacularAPIView.as_view(), name="schema"),
    path("docs", SpectacularSwaggerView.as_view(url_name="schema"), name="docs"),
]
