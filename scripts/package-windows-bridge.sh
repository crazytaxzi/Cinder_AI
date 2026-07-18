#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run build --workspace=@cinder/windows-bridge >/dev/null
out="$ROOT/release/CinderWindowsBridge"
rm -rf "$out"
mkdir -p "$out/dist"
cp -R apps/windows-bridge/dist/. "$out/dist/"
cp apps/windows-bridge/.env.example "$out/.env.example"
cp windows/CinderWindowsBridge/*.ps1 "$out/"
cat > "$out/package.json" <<'JSON'
{
  "name": "cinder-windows-bridge-runtime",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": { "start": "node dist/index.js" },
  "engines": { "node": ">=22.0.0" },
  "dependencies": {
    "dotenv": "17.4.2",
    "loudness": "0.4.2",
    "obs-websocket-js": "5.0.8",
    "pino": "10.3.1",
    "ws": "8.21.1",
    "zod": "4.4.3"
  }
}
JSON
mkdir -p release
python3 - <<'PY'
from pathlib import Path
import zipfile
root=Path('release/CinderWindowsBridge')
with zipfile.ZipFile('release/CinderWindowsBridge.zip','w',zipfile.ZIP_DEFLATED) as z:
    for p in sorted(root.rglob('*')):
        if p.is_file(): z.write(p, p.relative_to(root.parent))
PY
echo "$ROOT/release/CinderWindowsBridge.zip"
