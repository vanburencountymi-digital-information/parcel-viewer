from django.urls import path

from accounts import views

# No trailing slashes, like every other route (ADR 0011).
urlpatterns = [
    path("auth/login", views.LoginView.as_view(), name="auth-login"),
    path("auth/me", views.MeView.as_view(), name="auth-me"),
    path("auth/logout", views.LogoutView.as_view(), name="auth-logout"),
]
