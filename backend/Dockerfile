FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY parcel_viewer ./parcel_viewer
COPY app ./app

ENV PYTHONPATH=/app

# Run as an unprivileged user (DIC-1879): the API writes no files.
RUN useradd --system --uid 10001 --no-create-home appuser
USER appuser

# JSON logs for Cloud Logging / docker logs (ADR 0001).
ENV LOG_FORMAT=json
EXPOSE 8000
# /health is 503 when the database is down, so Docker marks the container unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
# --no-access-log: the app writes its own access line, with the request id.
# Multiple workers so one busy process can't take the API down (DIC-1853). Each
# worker has its own DB pool (PV_POOL_MAX, default 10) — size UVICORN_WORKERS
# against the database's connection limit.
ENV UVICORN_WORKERS=2
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${UVICORN_WORKERS} --no-access-log"]
