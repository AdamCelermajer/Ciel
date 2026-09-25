#!/usr/bin/env python3
"""Open the development window after Vite and the host API are ready."""

import os
import sys
import time
from pathlib import Path
from urllib.request import urlopen


url = os.environ["CIEL_SHELL_URL"] + "api/v1/health"
deadline = time.monotonic() + 60
while time.monotonic() < deadline:
    try:
        with urlopen(url, timeout=2) as response:
            if response.status == 200:
                break
    except OSError:
        pass
    time.sleep(0.5)
else:
    raise SystemExit("CIEL development server did not become ready within 60 seconds.")

shell = Path(__file__).resolve().parent.parent / "packaging/linux/ciel-shell.py"
os.execv(sys.executable, [sys.executable, str(shell)])
