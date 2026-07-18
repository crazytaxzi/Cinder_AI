#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo '1/9 Lockfile install'
npm ci --ignore-scripts=false
# A copied incremental build-info file can claim the workspace is current even
# when deploy-native intentionally excluded dist/. Always verify from real source.
npm run clean

echo '2/9 Production dependency security audit'
npm audit --omit=dev --omit=optional --audit-level=high

echo '3/9 TypeScript checks'
npm run typecheck

echo '4/9 Automated behavior and unit tests'
npm test

echo '5/9 Production build'
npm run build

echo '6/9 Behavioral evaluation contract'
npm run eval

echo '7/9 Windows bridge package'
npm run package:windows >/dev/null

echo '8/9 Migration and shell validation'
if grep -Eiq '^\s*(BEGIN|COMMIT);' migrations/*.sql; then
  echo 'Migration files may not wrap themselves in transactions.' >&2
  exit 1
fi
for file in scripts/*.sh; do bash -n "$file"; done
bash -n scripts/cinderctl
python3 -m py_compile scripts/native_env.py scripts/piper-worker.py

echo '9/9 Dashboard asset and production static-server validation'
test -s dashboard/index.html
test -s dashboard/login.html
test -s dashboard/app.js
test -s dashboard/styles.css
grep -q '/api/verify-live' dashboard/app.js
grep -q 'Exact failures' dashboard/index.html
grep -q 'native dashboard static assets' apps/core/test/dashboard-static.test.ts

echo 'All native production verification gates passed.'
