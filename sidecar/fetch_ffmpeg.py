#!/usr/bin/env python3
"""
Download ffmpeg/ffprobe binaries for bundling with the sidecar.

Pulls minimal LGPL builds from the Codfish ffmpeg release on GitHub. The
binaries are produced by .github/workflows/build-ffmpeg.yml from a pinned
upstream ffmpeg tag with audio-only, GPL-free configure flags. See
sidecar/build_ffmpeg.sh for the exact build.

Usage:
    python sidecar/fetch_ffmpeg.py
"""

import io
import platform
import sys
import tarfile
import zipfile
from pathlib import Path
from urllib.request import urlopen

SCRIPT_DIR = Path(__file__).parent.resolve()
FFMPEG_DIR = SCRIPT_DIR / "ffmpeg"

# Bump this when you publish a new ffmpeg release via the build-ffmpeg
# workflow. Format: ffmpeg-<upstream-tag>-codfish.<revision>
RELEASE_TAG = "ffmpeg-n7.1-codfish.1"
RELEASE_BASE = (
    f"https://github.com/jbohlken/codfish/releases/download/{RELEASE_TAG}"
)

ARTIFACTS = {
    ("windows", "x86_64"): f"{RELEASE_BASE}/ffmpeg-windows-x64.zip",
    ("linux",   "x86_64"): f"{RELEASE_BASE}/ffmpeg-linux-x64.tar.xz",
    ("darwin",  "aarch64"): f"{RELEASE_BASE}/ffmpeg-macos-arm64.tar.xz",
}

WANTED = {"ffmpeg", "ffprobe", "ffmpeg.exe", "ffprobe.exe"}


def detect_platform() -> tuple[str, str]:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch_map = {
        "x86_64": "x86_64",
        "amd64": "x86_64",
        "aarch64": "aarch64",
        "arm64": "aarch64",
    }
    arch = arch_map.get(machine)
    if not arch:
        sys.exit(f"Unsupported architecture: {machine}")
    return system, arch


def fetch():
    system, arch = detect_platform()

    url = ARTIFACTS.get((system, arch))
    if not url:
        sys.exit(
            f"No prebuilt ffmpeg published for {system}/{arch}.\n"
            f"Build one locally with: sidecar/build_ffmpeg.sh"
        )

    FFMPEG_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Downloading {RELEASE_TAG} for {system}/{arch}...")
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
