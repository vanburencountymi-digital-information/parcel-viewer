from django.urls import path

from parcels import views

# Same paths as FastAPI, no trailing slashes (ADR 0011). The parcel id is matched as text
# so a non-integer gets FastAPI's 422, not Django's 404.
urlpatterns = [
    path("parcel/<str:parcel_id>", views.ParcelDetailView.as_view(), name="parcel-detail"),
    path(
        "parcel/<str:parcel_id>/history", views.ParcelHistoryView.as_view(), name="parcel-history"
    ),
    path("parcels", views.ParcelsInBboxView.as_view(), name="parcels-bbox"),
    path("cohort", views.CohortView.as_view(), name="cohort"),
    path("cohort/geographies", views.CohortGeographiesView.as_view(), name="cohort-geographies"),
    path("search", views.SearchView.as_view(), name="parcel-search"),
    path("nearest-road", views.NearestRoadView.as_view(), name="nearest-road"),
    path("streetview-target", views.StreetViewTargetView.as_view(), name="streetview-target"),
]
