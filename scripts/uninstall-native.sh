#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || exec sudo "$0" "$@"
read -r -p 'Type DELETE NATIVE CINDER AND DATABASE: ' confirm
[[ "$confirm" == 'DELETE NATIVE CINDER AND DATABASE' ]] || { echo 'Cancelled.'; exit 1; }
major="$(python3 /opt/cinder/current/scripts/native_env.py get --file /etc/cinder/cinder.env CINDER_PG_MAJOR 2>/dev/null || true)"
systemctl disable --now cinder.service 2>/dev/null || true
rm -f /etc/systemd/system/cinder.service /usr/local/bin/cinderctl
systemctl daemon-reload
if [[ -n "$major" ]] && command -v pg_dropcluster >/dev/null 2>&1; then pg_dropcluster --stop "$major" cinder || true; fi
rm -rf /opt/cinder /var/lib/cinder /etc/cinder
userdel cinder 2>/dev/null || true
echo 'Native Cinder, its dedicated PostgreSQL cluster, configuration, releases, and state were removed.'
