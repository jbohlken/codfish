#!/usr/bin/env python3
"""
Generate a sidecar-manifest.json for a Codfish sidecar release.

Usage:
    python sidecar/make_manifest.py --dir sidecar/dist/

Version is read from the VERSION constant in transcribe.py by default.
Override with --version if needed.

The --dir should contain release zips named like:
    transcribe-cpu-x86_64-pc-windows-msvc.zip
    transcribe-cuda-x86_64-pc-windows-msvc.zip

For zips over 2GB (GitHub's limit), split them into .part1, .part2, etc.
The script detects parts automatically and lists them in the manifest.
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()


def read_version_from_source() -> str:
    """Read VERSION from transcribe.py — single source of truth."""
    for line in (SCRIPT_DIR / "transcribe.py").read_text().splitlines():
        m = re.match(r'^VERSION\s*=\s*["\'](.+)["\']', line)
        if m:
            return m.group(1)
    sys.exit("ERROR: could not find VERSION in transcribe.py")

REPO = "jbohlken/codfish"
BINARY_PATTERN = re.compile(
    r"^transcribe-(?P<variant>cpu|cuda)-(?P<triple>[a-z0-9_-]+?)\.zip$"
)
PART_PATTERN = re.compile(
    r"^transcribe-(?P<variant>cpu|cuda)-(?P<triple>[a-z0-9_-]+?)\.zip\.part(?P<num>\d+)$"
)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description="Generate sidecar release manifest")
    parser.add_argument("--version", default=None, help="Sidecar version (default: read from transcribe.py)")
    parser.add_argument("--dir", required=True, help="Directory containing release binaries")
    args = parser.parse_args()

    args.version = args.version or read_version_from_source()
    print(f"Version: {args.version}")

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

    manifest = {
        "version": args.version,
        "variants": variants,
    }

    out_path = dist / "sidecar-manifest.json"
    with open(out_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\nManifest written to: {out_path}")
    print(f"Variants: {len(variants)}")


if __name__ == "__main__":
    main()
