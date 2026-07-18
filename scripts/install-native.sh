#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $EUID -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_USER="${SUDO_USER:-crazytaxzi}"
USER_HOME="$(getent passwd "$INSTALL_USER" | cut -d: -f6)"
OLD_PROJECT="$USER_HOME/Cinder"
CINDER_ROOT=/opt/cinder
CINDER_STATE=/var/lib/cinder
CINDER_ETC=/etc/cinder
CINDER_ENV="$CINDER_ETC/cinder.env"
NODE_VERSION=22.23.1
DASHBOARD_PORT=3100
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE="$CINDER_ROOT/releases/2.0.0-$STAMP"
LOGIN_FILE="$USER_HOME/Cinder-Dashboard-Login.txt"

say() { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$SOURCE_DIR" != "$OLD_PROJECT" ]] || fail "Extract the new package somewhere other than $OLD_PROJECT. The old directory is deleted only after verification."
[[ -f "$SOURCE_DIR/package-lock.json" ]] || fail 'package-lock.json is missing from the release.'
[[ -f "$SOURCE_DIR/scripts/native_env.py" ]] || fail 'This is not the complete native Cinder package.'

ENV_SOURCE="${CINDER_ENV_SOURCE:-}"
for candidate in "$ENV_SOURCE" "$CINDER_ENV" "$OLD_PROJECT/.env" "$SOURCE_DIR/.env"; do
  if [[ -n "$candidate" && -s "$candidate" ]]; then ENV_SOURCE="$candidate"; break; fi
done
[[ -n "$ENV_SOURCE" && -s "$ENV_SOURCE" ]] || fail "Could not find the preserved Cinder .env. Expected $OLD_PROJECT/.env or use CINDER_ENV_SOURCE=/path/to/.env."

say 'Cinder Native 2.0 production installation'
say 'No Cinder component will run in Docker.'
say "Preserving secrets from: $ENV_SOURCE"
say 'Other Docker workloads will not be stopped, changed, or inspected beyond identifying the old Cinder Compose project.'
say

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl xz-utils python3 rsync ffmpeg \
  postgresql postgresql-common postgresql-client

if ! id cinder >/dev/null 2>&1; then
  useradd --system --home-dir "$CINDER_STATE" --create-home --shell /usr/sbin/nologin cinder
fi
install -d -o root -g root -m 755 "$CINDER_ROOT" "$CINDER_ROOT/releases" "$CINDER_ROOT/runtime"
install -d -o cinder -g cinder -m 700 "$CINDER_STATE" "$CINDER_STATE/backups"
install -d -o root -g cinder -m 750 "$CINDER_ETC"

say 'Installing a private, checksum-verified Node.js runtime...'
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) fail "Unsupported architecture: $(uname -m)" ;;
esac
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
NODE_VERSION_DIR="$CINDER_ROOT/runtime/node-v${NODE_VERSION}-linux-${node_arch}"
if [[ ! -x "$NODE_VERSION_DIR/bin/node" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp:-}"' EXIT
  curl -fsSL "https://nodejs.org/download/release/v${NODE_VERSION}/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  curl -fsSL "https://nodejs.org/download/release/v${NODE_VERSION}/${NODE_ARCHIVE}" -o "$tmp/$NODE_ARCHIVE"
  (cd "$tmp" && grep " ${NODE_ARCHIVE}$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$tmp/$NODE_ARCHIVE" -C "$CINDER_ROOT/runtime"
  rm -rf "$tmp"; trap - EXIT
fi
ln -sfn "$NODE_VERSION_DIR" "$CINDER_ROOT/runtime/node"
export PATH="$CINDER_ROOT/runtime/node/bin:$PATH"
NODE="$CINDER_ROOT/runtime/node/bin/node"
NPM="$CINDER_ROOT/runtime/node/bin/npm"
"$NODE" --version
"$NPM" --version

say 'Creating an isolated native PostgreSQL cluster for Cinder...'
existing_cluster="$(pg_lsclusters --no-header 2>/dev/null | awk '$2=="cinder" {print $1" "$3" "$4; exit}')"
if [[ -n "$existing_cluster" ]]; then
  read -r PG_MAJOR PG_PORT PG_STATUS <<<"$existing_cluster"
  [[ "$PG_STATUS" == online ]] || pg_ctlcluster "$PG_MAJOR" cinder start
else
  PG_MAJOR="$(find /usr/lib/postgresql -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -V | tail -n1)"
  [[ -n "$PG_MAJOR" ]] || fail 'PostgreSQL installed, but no server version was found.'
  PG_PORT=55432
  while ss -ltnH | awk '{print $4}' | grep -Eq "[:.]${PG_PORT}$"; do PG_PORT=$((PG_PORT + 1)); done
  pg_createcluster "$PG_MAJOR" cinder --port "$PG_PORT" --start
fi
systemctl enable --now "postgresql@${PG_MAJOR}-cinder.service"

PRESERVED_ENV="$CINDER_STATE/preserved-input.env"
cp "$ENV_SOURCE" "$PRESERVED_ENV"
chown root:cinder "$PRESERVED_ENV"; chmod 640 "$PRESERVED_ENV"
python3 "$SOURCE_DIR/scripts/native_env.py" prepare \
  --source "$PRESERVED_ENV" \
  --target "$CINDER_ENV" \
  --pg-port "$PG_PORT" \
  --pg-major "$PG_MAJOR" \
  --port "$DASHBOARD_PORT" \
  --password-output "$LOGIN_FILE"
chown root:cinder "$CINDER_ENV"; chmod 640 "$CINDER_ENV"
[[ -f "$LOGIN_FILE" ]] && { chown "$INSTALL_USER:$INSTALL_USER" "$LOGIN_FILE"; chmod 600 "$LOGIN_FILE"; }

DB_USER="$(python3 "$SOURCE_DIR/scripts/native_env.py" get --file "$CINDER_ENV" POSTGRES_USER)"
DB_NAME="$(python3 "$SOURCE_DIR/scripts/native_env.py" get --file "$CINDER_ENV" POSTGRES_DB)"
DB_PASSWORD="$(python3 "$SOURCE_DIR/scripts/native_env.py" get --file "$CINDER_ENV" POSTGRES_PASSWORD)"
[[ "$DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail 'POSTGRES_USER contains unsupported characters.'
[[ "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail 'POSTGRES_DB contains unsupported characters.'

runuser -u postgres -- psql -p "$PG_PORT" -v role_name="$DB_USER" -v role_password="$DB_PASSWORD" --set ON_ERROR_STOP=1 <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role_name', :'role_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role_name') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'role_name', :'role_password') \gexec
SQL
if ! runuser -u postgres -- psql -p "$PG_PORT" -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  runuser -u postgres -- createdb -p "$PG_PORT" -O "$DB_USER" "$DB_NAME"
fi

say 'Staging the complete native release...'
install -d -o cinder -g cinder -m 750 "$RELEASE"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude .env --exclude '.repair-backups' \
  --exclude 'apps/*/dist' --exclude 'packages/*/dist' \
  "$SOURCE_DIR/" "$RELEASE/"
chown -R cinder:cinder "$RELEASE"
find "$RELEASE/scripts" -type f \( -name '*.sh' -o -name '*.py' -o -name 'cinderctl' \) -exec chmod +x {} +

say 'Running the full clean build and automated verification as the Cinder service user...'
runuser -u cinder -- env \
  HOME="$CINDER_STATE" \
  PATH="$CINDER_ROOT/runtime/node/bin:/usr/local/bin:/usr/bin:/bin" \
  npm_config_cache="$CINDER_STATE/.npm" \
  bash -lc "cd '$RELEASE' && npm run verify"

say 'Running the real OpenAI full-tool preflight before touching the live bot...'
CANDIDATE_ENV="$CINDER_STATE/candidate-$STAMP.env"
cp "$CINDER_ENV" "$CANDIDATE_ENV"
sed -i \
  -e "s#^MIGRATIONS_DIR=.*#MIGRATIONS_DIR=$RELEASE/migrations#" \
  -e "s#^CINDER_PROFILE_PATH=.*#CINDER_PROFILE_PATH=$RELEASE/config/cinder-profile.md#" \
  "$CANDIDATE_ENV"
chown root:cinder "$CANDIDATE_ENV"; chmod 640 "$CANDIDATE_ENV"
runuser -u cinder -- env \
  HOME="$CINDER_STATE" \
  PATH="$CINDER_ROOT/runtime/node/bin:/usr/local/bin:/usr/bin:/bin" \
  DOTENV_CONFIG_PATH="$CANDIDATE_ENV" \
  "$NODE" "$RELEASE/apps/core/dist/cli.js" self-test-standalone
rm -f "$CANDIDATE_ENV"

say 'Pruning development-only packages after all tests passed...'
runuser -u cinder -- env HOME="$CINDER_STATE" PATH="$CINDER_ROOT/runtime/node/bin:/usr/local/bin:/usr/bin:/bin" \
  bash -lc "cd '$RELEASE' && npm prune --omit=dev"
test -f "$RELEASE/apps/core/dist/index.js"
test -f "$RELEASE/packages/shared/dist/index.js"

PREVIOUS_TARGET="$(readlink -f "$CINDER_ROOT/current" 2>/dev/null || true)"
OLD_DOCKER_STOPPED=false
OLD_NATIVE_RUNNING=false
if systemctl is-active --quiet cinder.service 2>/dev/null; then
  OLD_NATIVE_RUNNING=true
  systemctl stop cinder.service
fi
if [[ -f "$OLD_PROJECT/compose.yaml" ]] && command -v docker >/dev/null 2>&1; then
  say 'Stopping only the old Cinder Docker application for cutover...'
  (cd "$OLD_PROJECT" && docker compose stop app) || true
  OLD_DOCKER_STOPPED=true
fi

ln -sfn "$RELEASE" "$CINDER_ROOT/current"
cat > /etc/systemd/system/cinder.service <<EOF
[Unit]
Description=Cinder, Senti's shoulder demon
After=network-online.target postgresql@${PG_MAJOR}-cinder.service
Wants=network-online.target
Requires=postgresql@${PG_MAJOR}-cinder.service

[Service]
Type=simple
User=cinder
Group=cinder
WorkingDirectory=/opt/cinder/current
Environment=NODE_ENV=production
Environment=DOTENV_CONFIG_PATH=/etc/cinder/cinder.env
ExecStart=/opt/cinder/runtime/node/bin/node /opt/cinder/current/apps/core/dist/index.js
Restart=on-failure
RestartSec=5
TimeoutStartSec=180
TimeoutStopSec=45
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/var/lib/cinder
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cinder

[Install]
WantedBy=multi-user.target
EOF
install -m 755 "$RELEASE/scripts/cinderctl" /usr/local/bin/cinderctl
systemctl daemon-reload
systemctl enable cinder.service
systemctl start cinder.service

rollback() {
  say 'Native verification failed. Rolling back automatically.' >&2
  systemctl stop cinder.service 2>/dev/null || true
  if [[ -n "$PREVIOUS_TARGET" && -d "$PREVIOUS_TARGET" ]]; then
    ln -sfn "$PREVIOUS_TARGET" "$CINDER_ROOT/current"
    systemctl start cinder.service || true
  elif [[ "$OLD_DOCKER_STOPPED" == true && -f "$OLD_PROJECT/compose.yaml" ]]; then
    (cd "$OLD_PROJECT" && docker compose up -d app) || true
  fi
  journalctl -u cinder.service -n 220 --no-pager || true
  exit 1
}

say 'Waiting for the native systemd service...'
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${DASHBOARD_PORT}/health/ready" >/dev/null 2>&1; then break; fi
  systemctl is-failed --quiet cinder.service && rollback
  sleep 3
done
curl -fsS "http://127.0.0.1:${DASHBOARD_PORT}/health/ready" >/dev/null || rollback

say 'Running the required live Discord, administration, and Twitch verification...'
if ! /usr/local/bin/cinderctl verify-live; then rollback; fi

say 'Live verification passed. Removing the old Cinder Docker installation and old files...'
if [[ -f "$OLD_PROJECT/compose.yaml" ]] && command -v docker >/dev/null 2>&1; then
  (cd "$OLD_PROJECT" && docker compose down --volumes --remove-orphans --rmi local) || true
fi
rm -rf "$OLD_PROJECT"
find "$USER_HOME" -maxdepth 1 -type f \( \
  -iname '*cindercord*.sh' -o -iname '*cinder*patch*.sh' -o -iname '*cinder*repair*.sh' -o \
  -iname 'Cinder_Complete_1.*.zip' -o -iname 'CinderCord*.zip' \
\) -delete 2>/dev/null || true
rm -f "$CINDER_STATE/preserved-input.env"

# Keep the most recent successful release and one predecessor for native rollback.
mapfile -t releases < <(find "$CINDER_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk '{print $2}')
for old in "${releases[@]:2}"; do rm -rf "$old"; done

say
say 'Cinder Native is installed and verified.'
/usr/local/bin/cinderctl status || true
say
if [[ -f "$LOGIN_FILE" ]]; then
  say "Dashboard login was saved to: $LOGIN_FILE"
  cat "$LOGIN_FILE"
fi
say 'Configure remote dashboard access now.'
"$RELEASE/scripts/expose-dashboard.sh"
