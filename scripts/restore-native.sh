#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/native-lib.sh"
file="${1:-}"
[[ -f "$file" ]] || fail 'Usage: restore-native.sh /var/lib/cinder/backups/cinder-TIMESTAMP.dump'
read -r -p 'Type RESTORE CINDER DATABASE: ' confirm
[[ "$confirm" == 'RESTORE CINDER DATABASE' ]] || fail 'Restore cancelled.'
port="$(env_get CINDER_PG_PORT)"; user="$(env_get POSTGRES_USER)"; db="$(env_get POSTGRES_DB)"
export PGPASSWORD="$(env_get POSTGRES_PASSWORD)"
sudo systemctl stop cinder.service
sudo -u postgres dropdb -p "$port" --if-exists --force "$db"
sudo -u postgres createdb -p "$port" -O "$user" "$db"
pg_restore -h 127.0.0.1 -p "$port" -U "$user" -d "$db" --no-owner --no-acl "$file"
sudo systemctl start cinder.service
wait_ready 180 || { journalctl -u cinder.service -n 200 --no-pager; fail 'Cinder failed after restore.'; }
say 'Cinder database restored and verified.'
