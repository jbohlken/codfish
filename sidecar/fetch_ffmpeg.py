#!/usr/bin/env python3
"""
Download LGPL-licensed ffmpeg binaries from BtbN/FFmpeg-Builds.

Places ffmpeg (and ffprobe) into sidecar/ffmpeg/ for bundling by build.py.
Only needs to be run once, or when you want to update the ffmpeg version.

Usage:
    python sidecar/fetch_ffmpeg.py
"""

import io
import platform
import sys
import zipfile
import tarfile
from pathlib import Path
from urllib.request import urlopen

SCRIPT_DIR = Path(__file__).parent.resolve()
FFMPEG_DIR = SCRIPT_DIR / "ffmpeg"

# BtbN release URL patterns (static LGPL builds)
BASE_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest"

BUILDS = {
    ("windows", "x86_64"): f"{BASE_URL}/ffmpeg-master-latest-win64-lgpl.zip",
    ("linux", "x86_64"):   f"{BASE_URL}/ffmpeg-master-latest-linux64-lgpl.tar.xz",
    ("linux", "aarch64"):  f"{BASE_URL}/ffmpeg-master-latest-linuxarm64-lgpl.tar.xz",
}

# Binaries to extract
WANTED = {"ffmpeg", "ffprobe", "ffmpeg.exe", "ffprobe.exe"}


def detect_platform() -> tuple[str, str]:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch_map = {"x86_64": "x86_64", "amd64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}
    arch = arch_map.get(machine)
    if not arch:
        sys.exit(f"Unsupported architecture: {machine}")
    return system, arch


def fetch():
    system, arch = detect_platform()
    url = BUILDS.get((system, arch))
    if not url:
        sys.exit(
            f"No pre-built LGPL ffmpeg available for {system}/{arch}.\n"
            "For macOS, install ffmpeg via Homebrew: brew install ffmpeg"
        )

    FFMPEG_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Downloading LGPL ffmpeg for {system}/{arch}...")
    print(f"  {url}")
    data = urlopen(url).read()
    print(f"  Downloaded {len(data) / 1e6:.1f} MB")

    extracted = []
    if url.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for info in zf.infolist():
                name = Path(info.filename).name
                if name in WANTED:
                    dest = FFMPEG_DIR / name
                    dest.write_bytes(zf.read(info.filename))
                    extracted.append(dest)
    else:
        with tarfile.open(fileobj=io.BytesIO(data)) as tf:
            for member in tf.getmembers():
                name = Path(member.name).name
                if name in WANTED:
                    dest = FFMPEG_DIR / name
                    with tf.extractfile(member) as f:
                        dest.write_bytes(f.read())
                    dest.chmod(0o755)
                    extracted.append(dest)

    if not extracted:
        sys.exit("ERROR: No ffmpeg/ffprobe binaries found in archive.")

    for p in extracted:
        print(f"  Extracted: {p}  ({p.stat().st_size / 1e6:.1f} MB)")

    print(f"\nDone. Binaries are in {FFMPEG_DIR}/")


if __name__ == "__main__":
    fetch()
