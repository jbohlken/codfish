#!/usr/bin/env python3
"""
Collect license texts for all installed Python packages and write a single
THIRD_PARTY_LICENSES.txt file suitable for bundling with the sidecar binary.

Requires pip-licenses:  pip install pip-licenses

Usage:
    python sidecar/collect_licenses.py               # writes to sidecar/dist/transcribe/THIRD_PARTY_LICENSES.txt
    python sidecar/collect_licenses.py --out path.txt # writes to a custom path
"""

import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
DEFAULT_OUT = SCRIPT_DIR / "dist" / "transcribe" / "THIRD_PARTY_LICENSES.txt"


def main():
    out_path = DEFAULT_OUT
    for i, arg in enumerate(sys.argv[1:], 1):
        if arg == "--out" and i < len(sys.argv) - 1:
            out_path = Path(sys.argv[i + 1])

    # Ensure pip-licenses is available
    try:
        import importlib
        importlib.import_module("piplicenses")
    except ImportError:
        print("Installing pip-licenses...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pip-licenses", "-q"])

    result = subprocess.run(
        [
            sys.executable, "-m", "piplicenses",
            "--format=plain-vertical",
            "--with-license-file",
            "--no-license-path",
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        print(f"pip-licenses failed:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)

    header = (
        "THIRD-PARTY SOFTWARE LICENSES\n"
        "=============================\n"
        "\n"
        "The Codfish transcription sidecar bundles the following Python\n"
        "packages. Each package's license text is reproduced below.\n"
        "\n"
        "=" * 72 + "\n\n"
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(header + result.stdout, encoding="utf-8")
    print(f"Wrote {out_path} ({out_path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
