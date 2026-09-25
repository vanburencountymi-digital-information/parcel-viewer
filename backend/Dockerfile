FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY parcel_viewer ./parcel_viewer
COPY app ./app

ENV PYTHONPATH=/app
EXPOSE 8000
# Multiple workers so one busy process can't take the API down (DIC-1853). Each
# worker has its own DB pool (PV_POOL_MAX, default 10) — size UVICORN_WORKERS
# against the database's connection limit.
ENV UVICORN_WORKERS=2
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${UVICORN_WORKERS}"]
