#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/native-lib.sh"
need pg_dump
mkdir -p "$CINDER_STATE/backups"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$CINDER_STATE/backups/cinder-$stamp.dump"
port="$(env_get CINDER_PG_PORT)"; user="$(env_get POSTGRES_USER)"; db="$(env_get POSTGRES_DB)"
export PGPASSWORD="$(env_get POSTGRES_PASSWORD)"
pg_dump -h 127.0.0.1 -p "$port" -U "$user" -d "$db" --format=custom --no-owner --no-acl -f "$file"
cp "$CINDER_ENV" "$CINDER_STATE/backups/cinder-$stamp.env"
sha256sum "$file" "$CINDER_STATE/backups/cinder-$stamp.env" > "$CINDER_STATE/backups/cinder-$stamp.sha256"
chmod 600 "$CINDER_STATE/backups/cinder-$stamp".*
echo "$file"
