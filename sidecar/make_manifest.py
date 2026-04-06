#!/usr/bin/env python3
"""
Generate a sidecar-manifest.json for a Codfish sidecar release.

Usage:
    python sidecar/make_manifest.py --version 0.1.0 --dir sidecar/dist/

The --dir should contain release binaries named like:
    transcribe-cpu-x86_64-pc-windows-msvc.exe
    transcribe-cuda-x86_64-pc-windows-msvc.exe

For binaries over 2GB (GitHub's limit), split them into .part1, .part2, etc.
The script detects parts automatically and lists them in the manifest.
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

REPO = "jbohlken/codfish"
BINARY_PATTERN = re.compile(
    r"^transcribe-(?P<variant>cpu|cuda)-(?P<triple>[a-z0-9_-]+?)(?:\.exe)?$"
)
PART_PATTERN = re.compile(
    r"^transcribe-(?P<variant>cpu|cuda)-(?P<triple>[a-z0-9_-]+?)\.exe\.part(?P<num>\d+)$"
)
FFPROBE_PATTERN = re.compile(
    r"^ffprobe-(?P<triple>[a-z0-9_-]+?)(?:\.exe)?$"
)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description="Generate sidecar release manifest")
    parser.add_argument("--version", required=True, help="Sidecar version (e.g. 0.1.0)")
    parser.add_argument("--dir", required=True, help="Directory containing release binaries")
    args = parser.parse_args()

    dist = Path(args.dir)
    if not dist.is_dir():
        sys.exit(f"Directory not found: {dist}")

    tag = f"sidecar-v{args.version}"
    variants = {}

    # Collect parts keyed by (variant, triple)
    parts: dict[tuple[str, str], list[Path]] = {}
    for path in sorted(dist.iterdir()):
        m = PART_PATTERN.match(path.name)
        if m:
            key = (m.group("variant"), m.group("triple"))
            parts.setdefault(key, []).append(path)

    # Process single-file binaries
    for path in sorted(dist.iterdir()):
        match = BINARY_PATTERN.match(path.name)
        if not match:
            continue

        variant = match.group("variant")
        triple = match.group("triple")
        key = f"{variant}-{triple}"

        # Skip if this variant has parts instead
        if (variant, triple) in parts:
            continue

        print(f"  {key}: {path.name} ({path.stat().st_size / 1_000_000:.1f} MB)")

        variants[key] = {
            "url": f"https://github.com/{REPO}/releases/download/{tag}/{path.name}",
            "sha256": sha256_file(path),
            "size_bytes": path.stat().st_size,
        }

    # Process multi-part binaries
    for (variant, triple), part_files in sorted(parts.items()):
        key = f"{variant}-{triple}"
        part_files.sort(key=lambda p: int(PART_PATTERN.match(p.name).group("num")))

        # Compute SHA-256 of the full reassembled binary
        full_hash = hashlib.sha256()
        total_size = 0
        part_entries = []

        for pf in part_files:
            size = pf.stat().st_size
            total_size += size
            with open(pf, "rb") as f:
                while chunk := f.read(8192):
                    full_hash.update(chunk)
            part_entries.append({
                "url": f"https://github.com/{REPO}/releases/download/{tag}/{pf.name}",
                "sha256": sha256_file(pf),
                "size_bytes": size,
            })
            print(f"  {key}: {pf.name} ({size / 1_000_000:.1f} MB)")

        variants[key] = {
            "sha256": full_hash.hexdigest(),
            "size_bytes": total_size,
            "parts": part_entries,
        }

    if not variants:
        sys.exit(f"No release binaries found in {dist}")

    # Collect standalone ffprobe binaries
    ffprobe = {}
    for path in sorted(dist.iterdir()):
        match = FFPROBE_PATTERN.match(path.name)
        if not match:
            continue
        triple = match.group("triple")
        print(f"  ffprobe-{triple}: {path.name} ({path.stat().st_size / 1_000_000:.1f} MB)")
        ffprobe[triple] = {
            "url": f"https://github.com/{REPO}/releases/download/{tag}/{path.name}",
            "sha256": sha256_file(path),
            "size_bytes": path.stat().st_size,
        }

    manifest = {
        "version": args.version,
        "variants": variants,
    }
    if ffprobe:
        manifest["ffprobe"] = ffprobe

    out_path = dist / "sidecar-manifest.json"
    with open(out_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\nManifest written to: {out_path}")
    print(f"Variants: {len(variants)}")


if __name__ == "__main__":
    main()
