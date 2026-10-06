from django.urls import path

from wms import views

urlpatterns = [
    path("wms-proxy", views.WmsProxyView.as_view(), name="wms-proxy"),
]
