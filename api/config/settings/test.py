"""Test settings: deterministic, no network, one Postgres test database for every alias."""

import os

# Set before base is imported so the suite never needs a real .env.
os.environ.setdefault("SECRET_KEY", "test-only-secret-key")
os.environ.setdefault("DATABASE_URL", "postgis://api:api@localhost:5433/parcel_viewer_api")
os.environ.setdefault("PV_DATABASE_URL", os.environ["DATABASE_URL"])
os.environ["ENVIRONMENT"] = "test"

from .base import *  # noqa: E402, F403

DEBUG = False
TEST_RUNNER = "common.test_runner.PooledTestRunner"
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]

# Tests never reach the shared database: the parcels and config-store aliases point at the
# default test database, and the parcels connection stays read-only there too.
for _alias in (DatabaseAlias.PARCELS, DatabaseAlias.CONFIG_STORE):  # noqa: F405
    DATABASES[_alias]["TEST"] = {"MIRROR": DatabaseAlias.DEFAULT}  # noqa: F405

# Rate limits must not interfere with unrelated tests; throttling has its own tests.
REST_FRAMEWORK = {
    **REST_FRAMEWORK,  # noqa: F405
    "DEFAULT_THROTTLE_RATES": {"anon": "1000/min", "user": "1000/min"},
}
