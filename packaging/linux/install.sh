#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd -- "$(dirname -- "$0")/.." && pwd)"
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/ciel/app"
mkdir -p "$install_dir" "$HOME/.config/systemd/user" "$HOME/.local/share/applications"
if systemctl --user is-active --quiet ciel.service; then
  printf '%s\n' 'CIEL is running. Finish active tasks and stop ciel.service before upgrading.' >&2
  exit 1
fi
cp -a "$source_dir/." "$install_dir/"
chmod +x "$install_dir/setup/ciel-open"
install -m755 "$install_dir/setup/ciel-update" "${XDG_DATA_HOME:-$HOME/.local/share}/ciel/ciel-update"
cat > "$HOME/.config/systemd/user/ciel.service" <<EOF
[Unit]
Description=CIEL personal coding host
After=network-online.target
[Service]
Type=simple
WorkingDirectory=$install_dir
ExecStart="$install_dir/runtime/bin/node" "$install_dir/dist/host/main.cjs"
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=30
UMask=0077
[Install]
WantedBy=default.target
EOF
cat > "$HOME/.local/share/applications/io.ciel.Ciel.desktop" <<EOF
[Desktop Entry]
Name=CIEL Desktop
Comment=Your code, everywhere
Exec="$install_dir/setup/ciel-open"
Icon=$install_dir/ciel.svg
Type=Application
Terminal=false
Categories=Development;
StartupWMClass=io.ciel.Ciel
EOF
systemctl --user daemon-reload
systemctl --user enable --now ciel.service
printf '%s\n' 'CIEL installed. Open http://127.0.0.1:4317 or launch CIEL from your applications.'
