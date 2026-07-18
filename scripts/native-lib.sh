#!/usr/bin/env bash
set -Eeuo pipefail

CINDER_ROOT="${CINDER_ROOT:-/opt/cinder}"
CINDER_CURRENT="$CINDER_ROOT/current"
CINDER_ENV="${CINDER_ENV:-/etc/cinder/cinder.env}"
CINDER_STATE="${CINDER_STATE:-/var/lib/cinder}"
NODE_HOME="$CINDER_ROOT/runtime/node"
NODE="$NODE_HOME/bin/node"
NPM="$NODE_HOME/bin/npm"

say() { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required."; }
env_get() { python3 "$CINDER_CURRENT/scripts/native_env.py" get --file "$CINDER_ENV" "$1"; }
wait_ready() {
  local seconds="${1:-180}" port deadline
  port="$(env_get PORT)"; port="${port:-3100}"
  deadline=$((SECONDS + seconds))
  while (( SECONDS < deadline )); do
    if curl -fsS "http://127.0.0.1:${port}/health/ready" >/dev/null 2>&1; then return 0; fi
    if systemctl is-failed --quiet cinder.service; then return 1; fi
    sleep 3
  done
  return 1
}
control_post() {
  local path="$1" token port
  token="$(env_get CINDER_INTERNAL_CONTROL_TOKEN)"
  port="$(env_get PORT)"; port="${port:-3100}"
  curl -fsS -X POST -H "x-cinder-control-token: $token" -H 'content-type: application/json' -d '{}' "http://127.0.0.1:${port}${path}"
}
