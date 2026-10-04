FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# Run as an unprivileged user (DIC-1879): the service writes no files.
RUN useradd --system --uid 10001 --no-create-home appuser
USER appuser

# JSON logs: Cloud Run's Logs tab and Cloud Logging index the fields (ADR 0001).
ENV LOG_FORMAT=json
EXPOSE 8000
# Used by Docker/compose; Cloud Run runs its own startup probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
# --no-access-log: the app writes its own access line, with the request id.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
