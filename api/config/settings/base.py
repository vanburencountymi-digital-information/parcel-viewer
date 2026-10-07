"""
Django settings for the parcel viewer API (DIC-2146).

All environment-specific values come from environment variables (django-environ); see
.env.example. `config.settings.test` layers test-only overrides on top of this module.
"""

from pathlib import Path
from typing import Any

import django_stubs_ext
import environ
from django.core.exceptions import ImproperlyConfigured
from psycopg_pool import ConnectionPool

from common.enums import DatabaseAlias, Environment
from common.error_logging_client import init_error_monitoring
from common.logging_setup import configure_logging

# Lets type-annotated generics such as QuerySet[Parcel] work at runtime.
django_stubs_ext.monkeypatch()

BASE_DIR = Path(__file__).resolve().parent.parent.parent

env = environ.Env()
environ.Env.read_env(BASE_DIR / ".env")

ENVIRONMENT = Environment(env.str("ENVIRONMENT", default=Environment.LOCAL))
IS_DEPLOYED = ENVIRONMENT in Environment.deployed()

# The key shipped in .env.example is only acceptable on a developer machine.
INSECURE_DEV_SECRET_KEY = "insecure-local-dev-key-change-me"
SECRET_KEY = env.str("SECRET_KEY")
if IS_DEPLOYED and SECRET_KEY == INSECURE_DEV_SECRET_KEY:
    raise ImproperlyConfigured("SECRET_KEY must be set to a real secret outside local/test.")

DEBUG = env.bool("DEBUG", default=False)
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=["localhost", "127.0.0.1"])
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])
# Deployed, TLS ends at the proxy in front of the container, which says so in this header;
# locally everything is plain HTTP. Each setting is assigned unconditionally so Django's
# defaults never apply by accident.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https") if IS_DEPLOYED else None
SESSION_COOKIE_SECURE = IS_DEPLOYED
CSRF_COOKIE_SECURE = IS_DEPLOYED
SECURE_SSL_REDIRECT = IS_DEPLOYED
# Platform health probes call the container over plain HTTP inside the network.
SECURE_REDIRECT_EXEMPT = [r"^health$"]
# HSTS belongs with TLS, wherever production ends it (DIC-1863, infra/nginx.viewer.conf);
# off until that's decided.
SECURE_HSTS_SECONDS = env.int("SECURE_HSTS_SECONDS", default=0)

# The FastAPI routes have no trailing slash (/health, /parcel/1). The port keeps the same
# URLs (ADR 0011), so Django must not redirect them to a slashed version.
APPEND_SLASH = False

# The nearest git tag at image build time, baked in by the image build.
APP_VERSION = env.str("APP_VERSION", default="0.0.0")


# Application definition

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.gis",
    "django.contrib.postgres",
    "rest_framework",
    "drf_spectacular",
    "common",
    "parcels",
    "county_config",
    "wms",
    "feedback",
]

# Request ids outermost (every response, CORS rejections included, gets one), then
# security headers, so a CORS preflight answered by CorsMiddleware still gets them.
MIDDLEWARE = [
    "common.middleware.RequestIdMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "common.middleware.CorsMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"


# Databases (ADR 0004). Three aliases, each with its own small pool (ADR 0005):
#   default       Django's own tables; the only database `migrate` touches.
#   parcels       the assessing and geo tables, read-only (ADR 0007).
#   config_store  the existing config.config_versions table (ADR 0010).
POSTGIS = "django.contrib.gis.db.backends.postgis"
POOL_MAX_SIZE = env.int("DB_POOL_MAX", default=5)
STATEMENT_TIMEOUT_MS = env.int("DB_STATEMENT_TIMEOUT_MS", default=10000)
APPLICATION_NAME = "parcel-viewer-django"


def _database(
    url_var: str, *, read_only: bool = False, default_url: str | None = None
) -> dict[str, Any]:
    """
    Takes the environment variable holding a database URL, whether the connection must be
    read-only, and a fallback URL. Returns a Django DATABASES entry using the psycopg 3
    pool, with the same timeouts and keepalives as the FastAPI backend (DIC-1853, DIC-1872).
    """
    # Compose passes unset variables through as empty strings, so empty means "not set".
    url = env.str(url_var, default="") or default_url
    if not url:
        raise ImproperlyConfigured(f"{url_var} must be set.")
    config = env.db_url_config(url, engine=POSTGIS)
    session = f"-c statement_timeout={STATEMENT_TIMEOUT_MS}"
    if read_only:
        # The current reader login can also write (it is shared with parcel-studio), so
        # read-only is enforced on the session until a dedicated read-only role exists.
        session += " -c default_transaction_read_only=on"
    config["CONN_MAX_AGE"] = 0  # required by the pool; the pool keeps connections
    config["OPTIONS"] = {
        # check: test each connection before handing it out, so one the server or the
        # network dropped while idle is replaced instead of failing the request with a 503.
        "pool": {
            "min_size": 1,
            "max_size": POOL_MAX_SIZE,
            "timeout": 10,
            "check": ConnectionPool.check_connection,
        },
        "application_name": APPLICATION_NAME,
        "options": session,
        "connect_timeout": 5,
        "keepalives": 1,
        "keepalives_idle": 30,
        "keepalives_interval": 10,
        "keepalives_count": 3,
        "tcp_user_timeout": 10000,
    }
    return config


DATABASES = {
    DatabaseAlias.DEFAULT: _database("DATABASE_URL"),
    DatabaseAlias.PARCELS: _database("PV_DATABASE_URL", read_only=True),
    # Locally, without a writer URL, the config table lives in the Django database (the
    # compose database creates it from backend/migrations).
    DatabaseAlias.CONFIG_STORE: _database(
        "PV_WRITER_DATABASE_URL", default_url=env.str("DATABASE_URL")
    ),
}
DATABASE_ROUTERS = ["common.db_routers.DatabaseRouter"]
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"


AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True


# Static files (the admin's) are served by WhiteNoise, so no static bucket is needed.
STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedStaticFilesStorage"},
}


# REST framework. Secure by default: every view needs authentication unless it opts out
# (the public parcel routes do, ADR 0008), and every view is rate limited. The deployment
# layer adds its own limit on top.
REST_FRAMEWORK = {
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    # How many proxies sit in front of the app, so throttles see the real client address.
    "NUM_PROXIES": env.int("THROTTLE_NUM_PROXIES", default=None),
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "anon": env.str("THROTTLE_ANON", default="120/min"),
        "user": env.str("THROTTLE_USER", default="600/min"),
        # The viewer's own reads (/parcels on every map move, search as you type). Many
        # county staff can share one public IP, so this is per client but generous.
        "parcel_read": env.str("THROTTLE_PARCEL_READ", default="600/min"),
        # The config admin routes (shared admin key until phase 5, ADR 0008).
        "admin": env.str("THROTTLE_ADMIN", default="120/min"),
    },
    # Outages, load, rate limits and wrong methods answer as the FastAPI backend did.
    "EXCEPTION_HANDLER": "common.exceptions.api_exception_handler",
    # No OPTIONS metadata: FastAPI answered a plain OPTIONS with 405 (preflights are
    # answered by common.middleware.CorsMiddleware before DRF sees them).
    "DEFAULT_METADATA_CLASS": None,
    # JSON only, encoded like the FastAPI backend (ADR 0012); no browsable API.
    "DEFAULT_RENDERER_CLASSES": ["common.renderers.FastApiCompatibleJSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
}

# County config (DIC-465): the default county, the interim shared admin key (ADR 0008)
# and the config store's switches, named as the FastAPI backend named them.
DEFAULT_COUNTY = env.str("PV_DEFAULT_COUNTY", default="vanburen")
ADMIN_TOKEN = env.str("PV_ADMIN_TOKEN", default="")
# Store reads and writes need a real writer database; without one the API serves the baked
# manifests, as FastAPI did (the config_store alias's local fallback is for tests).
CONFIG_STORE_CONFIGURED = bool(env.str("PV_WRITER_DATABASE_URL", default=""))
CONFIG_STORE_RETRY_S = env.float("PV_CONFIG_STORE_RETRY_S", default=30.0)
DISCOVERY_CACHE_S = env.float("PV_DISCOVERY_CACHE_S", default=60.0)

# CORS (DIC-1852). The viewer and admin console call the API same-origin through nginx
# (/api/), so CORS only governs third-party browser callers: just the production viewer
# origin by default (PV_CORS_ORIGINS, comma-separated). No credentials.
CORS_ORIGINS = [
    o.strip()
    for o in env.str("PV_CORS_ORIGINS", default="https://gis.dicemi.org").split(",")
    if o.strip()
]
CORS_ALLOW_METHODS = ["GET", "POST", "PUT"]
CORS_ALLOW_HEADERS = ["Content-Type", "X-Admin-Token"]
CORS_EXPOSE_HEADERS = ["X-Request-ID"]

# The public write and proxy routes' limits, named as in the FastAPI backend (DIC-496,
# DIC-1852): per client, plus a global ceiling where every request emails or logs.
WMS_PROXY_RATE_LIMIT = env.str("WMS_PROXY_RATE_LIMIT", default="45/minute")
WMS_PROXY_MAX_BYTES = env.int("WMS_PROXY_MAX_BYTES", default=5 * 1024 * 1024)
REPORT_ERROR_RATE_LIMIT = env.str("REPORT_ERROR_RATE_LIMIT", default="5/hour")
REPORT_ERROR_GLOBAL_LIMIT = env.str("REPORT_ERROR_GLOBAL_LIMIT", default="100/day")
CLIENT_ERROR_RATE_LIMIT = env.str("CLIENT_ERROR_RATE_LIMIT", default="20/minute")
CLIENT_ERROR_GLOBAL_LIMIT = env.str("CLIENT_ERROR_GLOBAL_LIMIT", default="5000/day")

# Data-error report email. Without PV_SMTP_HOST, /report-error answers 503
# "email_not_configured" and the viewer shows a try-again state.
SMTP_HOST = env.str("PV_SMTP_HOST", default="")
SMTP_PORT = env.int("PV_SMTP_PORT", default=587)
SMTP_USER = env.str("PV_SMTP_USER", default="")
SMTP_PASSWORD = env.str("PV_SMTP_PASSWORD", default="")
SMTP_STARTTLS = env.str("PV_SMTP_STARTTLS", default="true").lower() != "false"
REPORT_TO = env.str("PV_REPORT_TO", default="gis@vanburencountymi.gov")
REPORT_FROM = env.str("PV_REPORT_FROM", default="")  # defaults to SMTP_USER when sending

# API docs exist for staff only (ADR 0009): the public FastAPI docs were turned off for
# security (DIC-1855), and the schema stays off the public internet.
SPECTACULAR_SETTINGS = {
    "TITLE": "Parcel viewer API",
    "DESCRIPTION": "Parcel lookup, search, cohorts and the county config store.",
    "VERSION": APP_VERSION,
    "SERVE_INCLUDE_SCHEMA": False,
    "SERVE_PERMISSIONS": ["rest_framework.permissions.IsAdminUser"],
}


# Logs and errors as the FastAPI backend writes them (ADR 0001), through the modules kept
# identical across the three services: stdout, one line per record (JSON with
# LOG_FORMAT=json, as the images set), each stamped with the request id. Sentry starts
# only when SENTRY_DSN is set (staging and production), and its events drop query strings,
# cookies and bodies, which can carry owner names.
LOGGING_CONFIG = None
configure_logging("parcel-api")
init_error_monitoring("parcel-api", APP_VERSION)
