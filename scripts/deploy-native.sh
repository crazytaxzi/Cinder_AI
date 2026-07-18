#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $EUID -ne 0 ]]; then exec sudo -E bash "$0" "$@"; fi
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CINDER_ROOT=/opt/cinder
CINDER_STATE=/var/lib/cinder
CINDER_ENV=/etc/cinder/cinder.env
NODE_HOME="$CINDER_ROOT/runtime/node"
NODE="$NODE_HOME/bin/node"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE="$CINDER_ROOT/releases/2.0.0-$STAMP"
PREVIOUS="$(readlink -f "$CINDER_ROOT/current" 2>/dev/null || true)"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ -x "$NODE" ]] || fail 'Native Cinder is not installed. Run install-native.sh first.'
[[ -f "$CINDER_ENV" ]] || fail 'Cinder environment is missing.'

install -d -o cinder -g cinder -m 750 "$RELEASE"
rsync -a --delete --exclude node_modules --exclude .git --exclude .env --exclude '.repair-backups' \
  --exclude 'apps/*/dist' --exclude 'packages/*/dist' --exclude '*.tsbuildinfo' "$SOURCE_DIR/" "$RELEASE/"
chown -R cinder:cinder "$RELEASE"
find "$RELEASE/scripts" -type f \( -name '*.sh' -o -name '*.py' -o -name 'cinderctl' \) -exec chmod +x {} +

runuser -u cinder -- env HOME="$CINDER_STATE" PATH="$NODE_HOME/bin:/usr/local/bin:/usr/bin:/bin" npm_config_cache="$CINDER_STATE/.npm" \
  bash -lc "cd '$RELEASE' && npm run verify"

CANDIDATE_ENV="$CINDER_STATE/candidate-$STAMP.env"
ENV_BACKUP="$CINDER_STATE/cinder-env-before-$STAMP.env"
cp "$CINDER_ENV" "$CANDIDATE_ENV"
sed -i -e "s#^MIGRATIONS_DIR=.*#MIGRATIONS_DIR=$RELEASE/migrations#" \
  -e "s#^CINDER_PROFILE_PATH=.*#CINDER_PROFILE_PATH=$RELEASE/config/cinder-profile.md#" "$CANDIDATE_ENV"
upsert_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$CANDIDATE_ENV"; then
    sed -i "s#^${key}=.*#${key}=${value}#" "$CANDIDATE_ENV"
  else
    printf '%s=%s\n' "$key" "$value" >> "$CANDIDATE_ENV"
  fi
}
upsert_env OPENAI_MODEL gpt-5.4-mini
upsert_env OPENAI_REASONING_EFFORT none
upsert_env OPENAI_TTS_INSTRUCTIONS 'A small mischievous imp with a lightly gravelly, raspy texture: smug, playful, crisp, and expressive. Keep the rasp subtle so every word stays clear. Never sound corporate.'
upsert_env CINDER_VOICE_SPEED 0.468
upsert_env CINDER_VOICE_PITCH 0.4981994
upsert_env LOCAL_PIPER_PYTHON /opt/cinder/local-voice/piper-venv/bin/python
upsert_env LOCAL_PIPER_MODEL /opt/cinder/local-voice/models/en_US-ryan-medium.onnx
upsert_env LOCAL_PIPER_WORKER "$RELEASE/scripts/piper-worker.py"
upsert_env LOCAL_WHISPER_BINARY /opt/cinder/local-voice/whisper.cpp/build/bin/whisper-cli
upsert_env LOCAL_WHISPER_MODEL /opt/cinder/local-voice/models/ggml-tiny.en.bin
upsert_env LOCAL_WHISPER_THREADS 2
upsert_env CINDER_VOICE_SOCIAL_MODEL gpt-5.4-nano
upsert_env CINDER_SOCIAL_MODEL gpt-5.4-nano
upsert_env CINDER_SOCIAL_CONTEXT_EVENT_LIMIT 10
upsert_env CINDER_SOCIAL_MAX_REPLY_CHARACTERS 500
upsert_env CINDER_VOICE_CLOUD_TRANSCRIPTION true
upsert_env CINDER_VOICE_CLOUD_STT_USD_PER_MINUTE 0.003
upsert_env CINDER_VOICE_CONTEXT_EVENT_LIMIT 8
upsert_env CINDER_VOICE_MAX_REPLY_CHARACTERS 220
upsert_env CINDER_VOICE_SPEECH_END_MS 550
upsert_env SCENE_RECENT_EVENT_LIMIT 12
upsert_env SCENE_MEMORY_LIMIT 8
upsert_env SCENE_RECENT_ACTION_LIMIT 8
upsert_env CINDER_MAX_TOOL_ROUNDS 3
upsert_env CINDER_MAX_OUTPUT_TOKENS 600
upsert_env CINDER_MAX_REPLY_CHARACTERS 900
chown root:cinder "$CANDIDATE_ENV"; chmod 640 "$CANDIDATE_ENV"
runuser -u cinder -- env HOME="$CINDER_STATE" PATH="$NODE_HOME/bin:/usr/local/bin:/usr/bin:/bin" DOTENV_CONFIG_PATH="$CANDIDATE_ENV" \
  "$NODE" "$RELEASE/apps/core/dist/cli.js" self-test-standalone
runuser -u cinder -- env HOME="$CINDER_STATE" PATH="$NODE_HOME/bin:/usr/local/bin:/usr/bin:/bin" \
  bash -lc "cd '$RELEASE' && npm prune --omit=dev"

systemctl stop cinder.service
cp "$CINDER_ENV" "$ENV_BACKUP"
chown root:cinder "$ENV_BACKUP"; chmod 640 "$ENV_BACKUP"
install -o root -g cinder -m 640 "$CANDIDATE_ENV" "$CINDER_ENV"
rm -f "$CANDIDATE_ENV"
ln -sfn "$RELEASE" "$CINDER_ROOT/current"
systemctl start cinder.service

rollback() {
  echo 'Deployment verification failed. Rolling back.' >&2
  systemctl stop cinder.service 2>/dev/null || true
  [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]] && ln -sfn "$PREVIOUS" "$CINDER_ROOT/current"
  [[ -f "$ENV_BACKUP" ]] && install -o root -g cinder -m 640 "$ENV_BACKUP" "$CINDER_ENV"
  systemctl start cinder.service 2>/dev/null || true
  journalctl -u cinder.service -n 220 --no-pager || true
  exit 1
}

for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:3100/health/ready >/dev/null 2>&1 && break
  systemctl is-failed --quiet cinder.service && rollback
  sleep 3
done
curl -fsS http://127.0.0.1:3100/health/ready >/dev/null || rollback
/usr/local/bin/cinderctl verify-live || rollback
rm -f "$ENV_BACKUP"

mapfile -t releases < <(find "$CINDER_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk '{print $2}')
for old in "${releases[@]:3}"; do rm -rf "$old"; done

echo "Cinder deployed and live verification passed: $RELEASE"
