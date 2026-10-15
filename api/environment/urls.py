from django.urls import path

from environment import views

urlpatterns = [
    path("environment", views.EnvironmentView.as_view(), name="environment"),
]
