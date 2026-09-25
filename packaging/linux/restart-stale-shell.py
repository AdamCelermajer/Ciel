#!/usr/bin/env python3
"""Reopen CIEL windows that were running before a rootless app update."""

import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def stale_windows(data_dir: Path, proc_root: Path = Path("/proc")) -> list[tuple[int, list[bytes], dict[str, str]]]:
    data_dir = data_dir.resolve()
    app_dir = data_dir / "app"
    previous_dir = data_dir / "app.previous"
    shell = app_dir / "setup/ciel-shell.py"
    try:
        current_version = (app_dir / "version.txt").read_text().strip()
        previous_version = (previous_dir / "version.txt").read_text().strip()
        installed_at = app_dir.stat().st_ctime
    except OSError:
        return []
    if not current_version or current_version == previous_version or not shell.is_file():
        return []

    found = []
    for proc in proc_root.iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            info = proc.stat()
            if info.st_uid != os.getuid() or info.st_mtime >= installed_at:
                continue
            command = (proc / "cmdline").read_bytes().rstrip(b"\0").split(b"\0")
            if len(command) != 2 or os.fsdecode(command[1]) != str(shell):
                continue
            variables = (proc / "environ").read_bytes().rstrip(b"\0").split(b"\0")
            environment = dict(os.fsdecode(entry).split("=", 1) for entry in variables if b"=" in entry)
            found.append((int(proc.name), command, environment))
        except (OSError, ValueError):
            continue
    return found


def main() -> None:
    data_dir = Path(sys.argv[1]).resolve()
    app_dir = data_dir / "app"
    shell = data_dir / "app/setup/ciel-shell.py"
    for pid, command, environment in stale_windows(data_dir):
        proc = Path("/proc") / str(pid)
        try:
            window = subprocess.Popen(
                [os.fsdecode(command[0]), str(shell)], cwd=app_dir, env=environment,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            time.sleep(1)
            if window.poll() is None and (proc / "cmdline").read_bytes().rstrip(b"\0").split(b"\0") == command:
                os.kill(pid, signal.SIGTERM)
        except (OSError, ValueError):
            continue


if __name__ == "__main__":
    main()
