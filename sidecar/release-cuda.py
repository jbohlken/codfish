#!/usr/bin/env python3
"""
Build and upload the CUDA sidecar variant to an existing GitHub release.

Prerequisites:
    - CUDA venv activated (sidecar/.venv-cuda)
    - gh CLI authenticated
    - CI has already built and published the CPU variants (draft release exists)

Usage:
    python sidecar/release-cuda.py --version 0.1.0

This script will:
    1. Build the CUDA sidecar binary
    2. Split it if over 2GB (GitHub's limit)
    3. Upload the CUDA binary/parts to the release
    4. Download the CPU binaries from the release
    5. Regenerate the manifest with all variants
    6. Upload the updated manifest
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
REPO_ROOT = SCRIPT_DIR.parent
DIST_DIR = SCRIPT_DIR / "dist"
REPO = "jbohlken/codfish"
SPLIT_THRESHOLD = 2_000_000_000  # 2GB


def run(cmd, **kwargs):
    print(f"  $ {' '.join(str(c) for c in cmd)}")
    result = subprocess.run(cmd, **kwargs)
    if result.returncode != 0:
        sys.exit(f"Command failed with exit code {result.returncode}")
    return result


def main():
    parser = argparse.ArgumentParser(description="Build and upload CUDA sidecar variant")
    parser.add_argument("--version", required=True, help="Sidecar version (e.g. 0.1.0)")
    args = parser.parse_args()

    tag = f"sidecar-v{args.version}"

    # Verify we're in the CUDA venv
    try:
        result = subprocess.run(
            [sys.executable, "-c", "import torch; print(torch.cuda.is_available())"],
            capture_output=True, text=True,
        )
        if result.stdout.strip() != "True":
            sys.exit("ERROR: CUDA not available. Activate the CUDA venv first:\n  sidecar\\.venv-cuda\\Scripts\\activate")
    except Exception:
        sys.exit("ERROR: Could not check CUDA availability. Is PyTorch installed?")

    # Verify gh CLI
    if not shutil.which("gh"):
        sys.exit("ERROR: gh CLI not found. Install it: https://cli.github.com/")

    # Verify release exists
    result = subprocess.run(
        ["gh", "release", "view", tag, "--repo", REPO],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        sys.exit(f"ERROR: Release {tag} not found. Run CI first by pushing the tag.")

    # ── 1. Clean dist and build ──────────────────────────────────────────
    print("\n=== Step 1: Building CUDA sidecar ===")
    # Remove old CUDA artifacts but keep CPU ones
    for f in DIST_DIR.glob("transcribe-cuda-*"):
        f.unlink()

    run([sys.executable, "sidecar/build.py", "--release", "--cuda"], cwd=REPO_ROOT)

    # Find the built binary
    cuda_bins = list(DIST_DIR.glob("transcribe-cuda-*"))
    if not cuda_bins:
        sys.exit("ERROR: No CUDA binary found in sidecar/dist/")
    cuda_bin = cuda_bins[0]
    size = cuda_bin.stat().st_size
    print(f"\nCUDA binary: {cuda_bin.name} ({size / 1e9:.2f} GB)")

    # ── 2. Split if needed ───────────────────────────────────────────────
    upload_files = []
    if size > SPLIT_THRESHOLD:
        print(f"\n=== Step 2: Splitting (over 2GB limit) ===")
        part_num = 1
        with open(cuda_bin, "rb") as f:
            while True:
                chunk = f.read(SPLIT_THRESHOLD - 100_000_000)  # ~1.9GB parts
                if not chunk:
                    break
                part_path = DIST_DIR / f"{cuda_bin.name}.part{part_num}"
                part_path.write_bytes(chunk)
                print(f"  {part_path.name} ({len(chunk) / 1e9:.2f} GB)")
                upload_files.append(part_path)
                part_num += 1
        # Remove the unsplit binary so it doesn't get uploaded
        cuda_bin.unlink()
    else:
        print("\n=== Step 2: No splitting needed ===")
        upload_files.append(cuda_bin)

    # ── 3. Upload CUDA files ─────────────────────────────────────────────
    print(f"\n=== Step 3: Uploading CUDA to {tag} ===")
    for f in upload_files:
        run(["gh", "release", "upload", tag, str(f), "--clobber", "--repo", REPO])

    # ── 4. Download CPU binaries ─────────────────────────────────────────
    print("\n=== Step 4: Downloading CPU binaries ===")
    run([
        "gh", "release", "download", tag,
        "--pattern", "transcribe-cpu-*",
        "--dir", str(DIST_DIR),
        "--clobber",
        "--repo", REPO,
    ])

    # ── 5. Regenerate manifest ───────────────────────────────────────────
    print("\n=== Step 5: Generating manifest ===")
    run([sys.executable, "sidecar/make_manifest.py", "--version", args.version, "--dir", str(DIST_DIR)], cwd=REPO_ROOT)

    # ── 6. Upload manifest ───────────────────────────────────────────────
    print(f"\n=== Step 6: Uploading manifest ===")
    run(["gh", "release", "upload", tag, str(DIST_DIR / "sidecar-manifest.json"), "--clobber", "--repo", REPO])

    print(f"\n=== Done! CUDA variant added to {tag} ===")
    print(f"Review the draft release: https://github.com/{REPO}/releases/tag/{tag}")


if __name__ == "__main__":
    main()
