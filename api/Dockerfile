# Parcel viewer API (Django + GeoDjango, DIC-2146). Targets: `production` (gunicorn, static files
# collected) and `dev` (the default, last stage: runserver).
#
#   make build && make up     start the API (and its local Postgres) beside the viewer stack
#   make test                 run the test suite
FROM python:3.12-slim AS base

# The nearest git tag at build time, passed in by `make build`. Read by settings as APP_VERSION.
ARG APP_VERSION=0.0.0

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    APP_VERSION=${APP_VERSION}

# GeoDjango loads GEOS, GDAL and PROJ through ctypes; gdal-bin pulls in all three.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gdal-bin binutils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Match the host user so files the container writes are editable locally.
RUN groupadd -g 1000 app && useradd -m -u 1000 -g app app && chown -R app:app /app


FROM base AS production
# The key only lets settings load while static files are collected; it is not kept.
RUN SECRET_KEY=build-only DATABASE_URL=postgis://x@localhost/x PV_DATABASE_URL=postgis://x@localhost/x \
    python manage.py collectstatic --noinput
USER app
# Two workers × a pool of 5 = at most 10 parcel connections (ADR 0005).
CMD ["sh", "-c", "exec gunicorn config.wsgi:application --bind 0.0.0.0:${PORT:-8000} --workers 2 --threads 4 --timeout 60 --access-logfile -"]


FROM base AS dev
USER app
EXPOSE 8000
CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
