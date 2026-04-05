#!/usr/bin/env python3
"""
Build the Codfish transcription sidecar with PyInstaller.

Prerequisites:
    python sidecar/fetch_ffmpeg.py           # one-time: downloads LGPL ffmpeg binaries

Dev builds (placed in src-tauri/binaries/ for local Tauri development):
    python sidecar/build.py                  # CPU build
    python sidecar/build.py --cuda           # CUDA build

Release builds (placed in sidecar/dist/ with variant naming for distribution):
    python sidecar/build.py --release        # CPU release
    python sidecar/build.py --release --cuda # CUDA release
    python sidecar/make_manifest.py --version X.Y.Z --dir sidecar/dist/

For a CUDA build, first install the CUDA requirements into your environment:
    pip install -r sidecar/requirements-cuda.txt
"""

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

# ── Resolve paths ──────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent.resolve()
REPO_ROOT = SCRIPT_DIR.parent
BINARIES_DIR = REPO_ROOT / "src-tauri" / "binaries"
DIST_DIR = SCRIPT_DIR / "dist"


def target_triple() -> str:
    machine = platform.machine().lower()
    system = platform.system().lower()

    arch_map = {
        "x86_64": "x86_64",
        "amd64": "x86_64",
        "arm64": "aarch64",
        "aarch64": "aarch64",
    }
    arch = arch_map.get(machine)
    if arch is None:
        sys.exit(f"Unsupported architecture: {machine}")

    if system == "windows":
        return f"{arch}-pc-windows-msvc"
    elif system == "darwin":
        return f"{arch}-apple-darwin"
    elif system == "linux":
        return f"{arch}-unknown-linux-gnu"
    else:
        sys.exit(f"Unsupported platform: {system}")


def check_cuda_available() -> bool:
    """Verify that the current Python env has CUDA-enabled PyTorch."""
    try:
        result = subprocess.run(
            [sys.executable, "-c", "import torch; print(torch.cuda.is_available())"],
            capture_output=True, text=True,
        )
        return result.stdout.strip() == "True"
    except Exception:
        return False


def main():
    cuda = "--cuda" in sys.argv
    release = "--release" in sys.argv
    triple = target_triple()
    is_windows = platform.system().lower() == "windows"

    if release:
        # Release builds include the variant in the filename for distribution
        variant = "cuda" if cuda else "cpu"
        binary_name = f"transcribe-{variant}-{triple}" + (".exe" if is_windows else "")
    else:
        # Dev builds use the Tauri target-triple convention
        binary_name = f"transcribe-{triple}" + (".exe" if is_windows else "")

    if cuda:
        if not check_cuda_available():
            sys.exit(
                "ERROR: --cuda specified but torch.cuda.is_available() is False.\n"
                "Install CUDA-enabled PyTorch first:\n"
                "  pip install -r sidecar/requirements-cuda.txt"
            )
        print("CUDA build: GPU acceleration will be available in the bundled binary.")
    else:
        print("CPU build: transcription will run on CPU only.")

    print(f"Build type    : {'CUDA' if cuda else 'CPU'}")
    print(f"Target triple : {triple}")
    print(f"Output binary : {BINARIES_DIR / binary_name}")
    print()

    # Locate LGPL ffmpeg binaries (fetched by fetch_ffmpeg.py)
    ffmpeg_dir = SCRIPT_DIR / "ffmpeg"
    add_binary_args = []
    ffmpeg_name = "ffmpeg.exe" if is_windows else "ffmpeg"
    ffprobe_name = "ffprobe.exe" if is_windows else "ffprobe"
    ffmpeg_bin = ffmpeg_dir / ffmpeg_name
    ffprobe_bin = ffmpeg_dir / ffprobe_name

    if ffmpeg_bin.is_file():
        add_binary_args += ["--add-binary", f"{ffmpeg_bin}{os.pathsep}."]
        print(f"Bundling ffmpeg:  {ffmpeg_bin}  ({ffmpeg_bin.stat().st_size / 1e6:.1f} MB)")
    else:
        sys.exit(
            f"ERROR: {ffmpeg_bin} not found.\n"
            "Run 'python sidecar/fetch_ffmpeg.py' first to download LGPL ffmpeg binaries."
        )

    if ffprobe_bin.is_file():
        add_binary_args += ["--add-binary", f"{ffprobe_bin}{os.pathsep}."]
        print(f"Bundling ffprobe: {ffprobe_bin}  ({ffprobe_bin.stat().st_size / 1e6:.1f} MB)")
    else:
        print("WARNING: ffprobe not found — audio stream detection will be skipped at runtime.")

    BINARIES_DIR.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--name", "transcribe",
        "--distpath", str(DIST_DIR),
        "--workpath", str(SCRIPT_DIR / "build"),
        "--specpath", str(SCRIPT_DIR),
        # Collect all submodules and data files
        "--collect-all", "whisperx",
        "--collect-all", "faster_whisper",
        "--collect-all", "ctranslate2",
        "--collect-all", "transformers",
        "--collect-all", "pyannote",
        # Copy package metadata so importlib.metadata.version() works at runtime
        "--copy-metadata", "torchcodec",
        "--copy-metadata", "transformers",
        "--copy-metadata", "whisperx",
        "--copy-metadata", "faster-whisper",
        "--copy-metadata", "torch",
        "--copy-metadata", "torchaudio",
        # Suppress the console window on Windows (stdout is still captured by Tauri)
        "--console",
        *add_binary_args,
        str(SCRIPT_DIR / "transcribe.py"),
    ]

    print("Running PyInstaller…")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        sys.exit(f"PyInstaller failed with exit code {result.returncode}")

    # ── Copy outputs ──────────────────────────────────────────────────────
    src_binary = DIST_DIR / ("transcribe.exe" if is_windows else "transcribe")

    if release:
        # Release: rename in-place in dist/ for make_manifest.py
        dst_binary = DIST_DIR / binary_name
        if dst_binary != src_binary:
            shutil.move(str(src_binary), str(dst_binary))
    else:
        # Dev: copy to src-tauri/binaries/ with target-triple naming
        BINARIES_DIR.mkdir(parents=True, exist_ok=True)
        dst_binary = BINARIES_DIR / binary_name
        shutil.copy2(src_binary, dst_binary)

    if not is_windows:
        dst_binary.chmod(0o755)

    print(f"\nBinary written to: {dst_binary}")
    print(f"Size: {dst_binary.stat().st_size / 1_000_000:.1f} MB")


if __name__ == "__main__":
    main()
