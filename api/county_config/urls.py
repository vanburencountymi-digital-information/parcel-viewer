from django.urls import path

from county_config import views

# Same paths as FastAPI, no trailing slashes (ADR 0011).
urlpatterns = [
    path("style.json", views.StyleView.as_view(), name="style"),
    path("config", views.CountyConfigView.as_view(), name="county-config"),
    path("config.js", views.CountyConfigScriptView.as_view(), name="county-config-script"),
    path("config/<str:county>/draft", views.DraftView.as_view(), name="config-draft"),
    path("config/<str:county>/publish", views.PublishView.as_view(), name="config-publish"),
    path("config/<str:county>/versions", views.VersionsView.as_view(), name="config-versions"),
    path("config/<str:county>/rollback", views.RollbackView.as_view(), name="config-rollback"),
    path("admin/discover/layers", views.DiscoverLayersView.as_view(), name="discover-layers"),
]
