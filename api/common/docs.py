"""API docs for staff only, and invisible to everyone else (ADR 0009).

A 401/403 would tell an anonymous caller the docs exist; the FastAPI backend's docs were
off (404) in production, and the post-deploy smoke test expects 404. So anyone who isn't
a signed-in staff user gets exactly the JSON 404 an unknown path gets, before the docs
views (which render YAML or HTML) run at all.
"""

from typing import Any

from django.http import HttpRequest, HttpResponseBase
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from rest_framework.permissions import IsAdminUser

from common.exceptions import not_found


def _is_staff(request: HttpRequest) -> bool:
    user = getattr(request, "user", None)
    return bool(user and user.is_active and user.is_staff)


class StaffSchemaView(SpectacularAPIView):
    permission_classes = [IsAdminUser]

    def dispatch(self, request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponseBase:
        if not _is_staff(request):
            return not_found(request)
        return super().dispatch(request, *args, **kwargs)


class StaffSwaggerView(SpectacularSwaggerView):
    permission_classes = [IsAdminUser]

    def dispatch(self, request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponseBase:
        if not _is_staff(request):
            return not_found(request)
        return super().dispatch(request, *args, **kwargs)
