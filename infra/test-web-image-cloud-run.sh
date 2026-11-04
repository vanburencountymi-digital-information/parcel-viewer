#!/usr/bin/env bash
# Checks the web image's Cloud Run settings (ADR 0018, infra/nginx/cloud-run-env.sh): it
# listens on $PORT, takes the client address from X-Forwarded-For by the configured hop
# count, shrinks the aerial cache, refuses bad values, and without them behaves as on the VM.
#
#   docker build -f infra/web.Dockerfile -t parcel-viewer-web:ci .
#   bash infra/test-web-image-cloud-run.sh parcel-viewer-web:ci
#
# In Git Bash on Windows, set MSYS_NO_PATHCONV=1 so container paths aren't rewritten.
set -euo pipefail

IMAGE="${1:?usage: test-web-image-cloud-run.sh <web image>}"
NAME="pv-web-cloud-run-test-$$"
HOST_PORT="${HOST_PORT:-18089}"
URL="http://localhost:$HOST_PORT/demo/"
# The upstream names nginx needs to start; nothing answers on them here.
HOSTS=(--add-host django-api:127.0.0.1 --add-host martin:127.0.0.1)

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; docker logs "$NAME" 2>&1 | tail -20 >&2 || true; exit 1; }

# Takes the container's settings (-e ...). Starts it on PORT=8080 and waits for /demo/.
start() {
  cleanup
  docker run -d --name "$NAME" -p "$HOST_PORT:8080" "${HOSTS[@]}" -e PORT=8080 "$@" "$IMAGE" >/dev/null
  for _ in $(seq 1 30); do
    if curl -fsS "$URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "nginx didn't answer on PORT=8080"
}

# Takes an X-Forwarded-For value. Prints the access-log line of a request carrying it (the
# newest /demo/ line: the log leaves out query strings, so requests can't be tagged).
logged_as() {
  curl -fsS -H "X-Forwarded-For: $1" "$URL" >/dev/null
  sleep 0.5
  docker logs "$NAME" 2>/dev/null | grep '"GET /demo/ ' | tail -1
}

# Takes an X-Forwarded-For value and the address its log line must start with.
expect_client() {
  local line
  line=$(logged_as "$1")
  case "$line" in
    "$2 "*) echo "ok: X-Forwarded-For '$1' -> $2" ;;
    *) fail "X-Forwarded-For '$1': expected the log line to start with '$2', got: $line" ;;
  esac
}

conf_has() { docker exec "$NAME" grep -qF "$1" /etc/nginx/conf.d/default.conf; }

echo "== Behind a load balancer: PV_TRUSTED_PROXY_HOPS=2"
start -e PV_TRUSTED_PROXY_HOPS=2 -e PV_AERIAL_CACHE_MAX=64m
conf_has "listen 8080;" || fail "not listening on PORT"
conf_has "max_size=64m " || fail "aerial cache not resized"
expect_client "198.51.100.1, 203.0.113.5, 192.0.2.9" 203.0.113.5
expect_client "203.0.113.77" 203.0.113.77

echo "== Cloud Run alone: PV_TRUSTED_PROXY_HOPS=1"
start -e PV_TRUSTED_PROXY_HOPS=1
expect_client "198.51.100.1, 203.0.113.6" 203.0.113.6

echo "== No hops (the VM): X-Forwarded-For is ignored"
start
line=$(logged_as "198.51.100.99")
case "$line" in
  198.51.100.99*) fail "a client-sent X-Forwarded-For was trusted with no hops: $line" ;;
  *) echo "ok: X-Forwarded-For ignored" ;;
esac

echo "== Bad values stop nginx from starting"
for bad in "PORT=abc" "PV_TRUSTED_PROXY_HOPS=5" "PV_AERIAL_CACHE_MAX=lots"; do
  if docker run --rm "${HOSTS[@]}" -e "$bad" "$IMAGE" nginx -t >/dev/null 2>&1; then
    fail "$bad was accepted"
  fi
  echo "ok: $bad refused"
done

echo "== Without the settings, the image is unchanged (compose, the VM)"
docker run --rm "${HOSTS[@]}" "$IMAGE" sh -c \
  'grep -q "listen 80;" /etc/nginx/conf.d/default.conf && grep -q "set \$pv_proxy_hops 0;" /etc/nginx/conf.d/default.conf && nginx -t' \
  >/dev/null 2>&1 || fail "the default image changed"
echo "ok: listen 80, no hops"

echo "All web image Cloud Run checks passed."
