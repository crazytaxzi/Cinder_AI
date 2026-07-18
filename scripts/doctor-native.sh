#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/native-lib.sh"
need curl
need python3
[[ -f "$CINDER_ENV" ]] || fail "$CINDER_ENV is missing."
[[ -x "$NODE" ]] || fail "The private Node runtime is missing."
systemctl is-active --quiet cinder.service || fail 'cinder.service is not active.'
wait_ready 30 || { journalctl -u cinder.service -n 160 --no-pager; fail 'Readiness failed.'; }
port="$(env_get PORT)"; port="${port:-3100}"
curl -fsS "http://127.0.0.1:${port}/health/ready" | python3 -m json.tool
pg_port="$(env_get CINDER_PG_PORT)"
pg_user="$(env_get POSTGRES_USER)"
pg_db="$(env_get POSTGRES_DB)"
pg_isready -h 127.0.0.1 -p "$pg_port" -U "$pg_user" -d "$pg_db"
say 'Cinder native doctor passed: systemd, PostgreSQL, OpenAI startup self-test, Discord, Twitch, and dashboard readiness are healthy.'
