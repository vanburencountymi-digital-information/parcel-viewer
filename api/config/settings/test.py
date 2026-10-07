"""Test settings: deterministic, no network, one Postgres test database for every alias."""

import os

# Set before base is imported so the suite never needs a real .env.
os.environ.setdefault("SECRET_KEY", "test-only-secret-key")
os.environ.setdefault("DATABASE_URL", "postgis://api:api@localhost:5433/parcel_viewer_api")
os.environ.setdefault("PV_DATABASE_URL", os.environ["DATABASE_URL"])
os.environ["ENVIRONMENT"] = "test"

from common.enums import DatabaseAlias  # noqa: E402
from config.settings import base  # noqa: E402

# Every setting from base (Django reads only UPPERCASE names), then the test overrides.
# Copied explicitly rather than with `import *`, which would also pull in base's helpers.
globals().update({name: value for name, value in vars(base).items() if name.isupper()})

DEBUG = False
TEST_RUNNER = "common.test_runner.PooledTestRunner"
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]

# Tests never reach the shared database: the parcels and config-store aliases point at the
# default test database, and the parcels connection stays read-only there too.
DATABASES = base.DATABASES
for alias in (DatabaseAlias.PARCELS, DatabaseAlias.CONFIG_STORE):
    DATABASES[alias]["TEST"] = {"MIRROR": DatabaseAlias.DEFAULT}

# Rate limits must not interfere with unrelated tests; throttling has its own tests.
REST_FRAMEWORK = {
    **base.REST_FRAMEWORK,
    "DEFAULT_THROTTLE_RATES": {
        "anon": "1000/min",
        "user": "1000/min",
        "parcel_read": "1000/min",
        "admin": "1000/min",
        "login": "1000/min",
    },
}
