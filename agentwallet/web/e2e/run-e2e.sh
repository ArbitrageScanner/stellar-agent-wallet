#!/usr/bin/env bash
# Runs the smoke test: installs playwright-core locally if needed, prepares
# Chromium (setup-chromium.sh), then runs smoke.mjs (which starts the mock).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
[ -d node_modules/playwright-core ] || npm install --no-audit --no-fund --silent
[ -f .pw/env.sh ] || bash setup-chromium.sh
# shellcheck disable=SC1091
source .pw/env.sh
exec node smoke.mjs "$@"
