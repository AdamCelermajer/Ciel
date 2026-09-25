#!/usr/bin/env python3
"""Register the source checkout as a persistent, per-user Fedora dev app."""

from pathlib import Path
import subprocess


root = Path(__file__).resolve().parent.parent
if not all((root / item).exists() for item in (
    "node_modules/.bin/concurrently",
    "node_modules/.bin/tsx",
    "apps/web/node_modules/.bin/vite",
)):
    raise SystemExit("Install development dependencies with pnpm install first.")


def quoted(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%") + '"'


service = f"""[Unit]
Description=CIEL development host and Vite server
After=network-online.target

[Service]
Type=simple
WorkingDirectory={str(root).replace(' ', '\\x20')}
ExecStart={quoted('/usr/bin/bash')} {quoted(str(root / 'scripts/dev.sh'))}
Restart=on-failure
RestartSec=3
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
"""
desktop = f"""[Desktop Entry]
Name=CIEL Dev
Comment=Live development version of CIEL
Exec={quoted('/usr/bin/bash')} {quoted(str(root / 'scripts/launch-dev-app.sh'))}
Icon={str(root / 'apps/web/public/ciel.svg')}
Type=Application
Terminal=false
Categories=Development;
StartupWMClass=io.ciel.CielDev
"""

service_file = Path.home() / ".config/systemd/user/ciel-dev.service"
desktop_file = Path.home() / ".local/share/applications/io.ciel.CielDev.desktop"
service_file.parent.mkdir(parents=True, exist_ok=True)
desktop_file.parent.mkdir(parents=True, exist_ok=True)
changed = not service_file.exists() or service_file.read_text() != service
if changed:
    service_file.write_text(service)
if not desktop_file.exists() or desktop_file.read_text() != desktop:
    desktop_file.write_text(desktop)
if changed:
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
subprocess.run(["systemctl", "--user", "enable", "--now", "ciel-dev.service"], check=True)
