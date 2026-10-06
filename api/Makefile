# Parcel viewer API (Django + GeoDjango, DIC-2146). Runs beside the viewer stack under the
# compose profile `django`; the repo-root .env supplies the parcel database URLs.
.PHONY: build up down logs migrate makemigrations shell pyshell test lint fmt typecheck check lock

COMPOSE = docker compose -f ../infra/docker-compose.viewer.yml --env-file ../.env --profile django
RUN = $(COMPOSE) run --rm django-api
# Tests use only the local database: the parcels and config-store aliases mirror it.
TEST_ENV = -e DJANGO_SETTINGS_MODULE=config.settings.test \
	-e PV_DATABASE_URL=postgis://api:api@api-db:5432/parcel_viewer_api -e PV_WRITER_DATABASE_URL=

build:
	# APP_VERSION is the nearest git tag; the fallback only applies before the first release.
	APP_VERSION=$$(git describe --tags --abbrev=0 2>/dev/null || echo 0.0.0) $(COMPOSE) build django-api

# Starts the API (http://localhost:8001) and its database; the viewer keeps using FastAPI.
up:
	$(COMPOSE) up -d api-db django-api

down:
	$(COMPOSE) stop django-api api-db

logs:
	$(COMPOSE) logs -f django-api

migrate:
	$(RUN) python manage.py migrate

makemigrations:
	$(RUN) python manage.py makemigrations

shell:
	$(RUN) /bin/sh

pyshell:
	$(RUN) python manage.py shell

test:
	$(COMPOSE) run --rm $(TEST_ENV) django-api python manage.py test --noinput

lint:
	$(RUN) sh -c "ruff check . && ruff format --check ."

fmt:
	$(RUN) sh -c "ruff check --fix . && ruff format ."

typecheck:
	$(COMPOSE) run --rm -e DJANGO_SETTINGS_MODULE=config.settings.test -e SECRET_KEY=typecheck-only django-api mypy .

# Fails if a model change is missing its migration. CI runs this too.
check:
	$(RUN) python manage.py makemigrations --check --dry-run

# Re-pin requirements.txt from requirements.in (run after editing requirements.in).
lock:
	docker run --rm -v "$$(pwd)":/w -w /w python:3.12-slim sh -c "pip install -q -r requirements.in && { echo '# Pinned from requirements.in (make lock). Do not edit by hand.'; pip freeze --exclude-editable; } > requirements.txt"
