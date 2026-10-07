"""Staff accounts in the Django admin, with the counties each one may edit (DIC-2151)."""

from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin

from accounts.models import CountyAccess


class CountyAccessInline(admin.TabularInline):
    model = CountyAccess
    extra = 1
    verbose_name = "county this user may edit"
    verbose_name_plural = "Counties this user may edit (superusers edit every county)"


User = get_user_model()
admin.site.unregister(User)


@admin.register(User)
class StaffUserAdmin(UserAdmin):
    inlines = [CountyAccessInline]
