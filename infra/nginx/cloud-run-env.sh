#!/bin/sh
# Cloud Run settings for the web image (ADR 0018). The nginx image's entrypoint runs this
# before nginx starts (it's /docker-entrypoint.d/40-pv-cloud-run-env.sh in the image). Each
# setting rewrites one line of the baked config, so they work only in the image as built.
# Compose mounts the config read-only and sets none of them; a setting given there anyway
# stops nginx from starting rather than being ignored.
#
#   PORT                   the port Cloud Run sends requests to (unset: 80)
#   PV_TRUSTED_PROXY_HOPS  Google proxies that append to X-Forwarded-For: 1 for Cloud Run
#                          alone, 2 behind an external load balancer (unset: 0, the VM)
#   PV_AERIAL_CACHE_MAX    the aerial tile cache's size, e.g. 100m (unset: 1g). On Cloud Run
#                          the disk is the instance's memory.
set -eu
conf=${PV_NGINX_CONF:-/etc/nginx/conf.d/default.conf}

# Takes a sed expression and the text it must produce. Fails when the line wasn't there.
rewrite() {
  sed -i "$1" "$conf"
  grep -qF "$2" "$conf" || { echo "cloud-run-env: '$2' not found in $conf" >&2; exit 1; }
}

if [ -n "${PORT:-}" ] && [ "$PORT" != 80 ]; then
  case "$PORT" in
    '' | *[!0-9]*) echo "cloud-run-env: PORT must be a number, not '$PORT'" >&2; exit 1 ;;
  esac
  rewrite "s/^\( *\)listen 80;/\1listen $PORT;/" "listen $PORT;"
fi

if [ -n "${PV_TRUSTED_PROXY_HOPS:-}" ] && [ "$PV_TRUSTED_PROXY_HOPS" != 0 ]; then
  case "$PV_TRUSTED_PROXY_HOPS" in
    1 | 2) ;;
    *) echo "cloud-run-env: PV_TRUSTED_PROXY_HOPS must be 0, 1 or 2, not '$PV_TRUSTED_PROXY_HOPS'" >&2; exit 1 ;;
  esac
  rewrite "s/set \$pv_proxy_hops 0;/set \$pv_proxy_hops $PV_TRUSTED_PROXY_HOPS;/" \
    "set \$pv_proxy_hops $PV_TRUSTED_PROXY_HOPS;"
fi

if [ -n "${PV_AERIAL_CACHE_MAX:-}" ]; then
  if ! echo "$PV_AERIAL_CACHE_MAX" | grep -qE '^[0-9]+[kmg]$'; then
    echo "cloud-run-env: PV_AERIAL_CACHE_MAX must look like 100m, not '$PV_AERIAL_CACHE_MAX'" >&2
    exit 1
  fi
  rewrite "s/max_size=1g /max_size=$PV_AERIAL_CACHE_MAX /" "max_size=$PV_AERIAL_CACHE_MAX "
fi
