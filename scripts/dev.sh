#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export CIEL_PORT="${CIEL_DEV_HOST_PORT:-4319}"
export CIEL_REMOTE_PORT="${CIEL_DEV_REMOTE_PORT:-4320}"
export CIEL_DEV_WEB_PORT="${CIEL_DEV_WEB_PORT:-5173}"
export CIEL_DATA_DIR="${CIEL_DEV_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/ciel-dev}"

if [[ "$CIEL_PORT" == "$CIEL_REMOTE_PORT" || "$CIEL_PORT" == "$CIEL_DEV_WEB_PORT" || "$CIEL_REMOTE_PORT" == "$CIEL_DEV_WEB_PORT" ]]; then
  echo "Development host, remote ingress, and web ports must differ." >&2
  exit 2
fi

echo "CIEL development: http://127.0.0.1:${CIEL_DEV_WEB_PORT}/ (data: ${CIEL_DATA_DIR})"

exec ./node_modules/.bin/concurrently -k -n host,web \
  './node_modules/.bin/tsx watch apps/host/src/main.ts' \
  'cd apps/web && ./node_modules/.bin/vite'
