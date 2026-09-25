#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
python3 scripts/install-dev-app.py

if ! python3 -c 'import gi; gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.1"); from gi.repository import Gtk, WebKit2' >/dev/null 2>&1; then
  echo "The CIEL Dev window needs Python GObject, GTK 3, and WebKitGTK 4.1. The browser is available at http://127.0.0.1:5173/." >&2
  exit 1
fi

export CIEL_SHELL_URL="http://127.0.0.1:${CIEL_DEV_WEB_PORT:-5173}/"
export CIEL_SHELL_PROFILE="ciel-dev"
export CIEL_SHELL_APP_ID="io.ciel.CielDev"
export CIEL_SHELL_TITLE="CIEL Dev"
exec python3 scripts/open-dev-app.py
