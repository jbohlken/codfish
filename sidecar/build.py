#!/usr/bin/env python3
"""
Build the Codfish transcription sidecar with PyInstaller (onedir mode).

Prerequisites:
    python sidecar/fetch_ffmpeg.py           # one-time: downloads LGPL ffmpeg binaries

Dev builds (placed in src-tauri/binaries/transcribe-{triple}/ for local Tauri):
    python sidecar/build.py                  # CPU build
    python sidecar/build.py --cuda           # CUDA build

Release builds (zipped in sidecar/dist/ for distribution):
    python sidecar/build.py --release        # CPU release
    python sidecar/build.py --release --cuda # CUDA release
    python sidecar/make_manifest.py --version X.Y.Z --dir sidecar/dist/

For a CUDA build, first install the CUDA requirements:
    pip install -r sidecar/requirements-cuda.txt
"""

import os
import platform
import shutil
import subprocess
import sys
import zipfile
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
    try:
        result = subprocess.run(
            [sys.executable, "-c", "import torch; print(torch.cuda.is_available())"],
            capture_output=True, text=True,
        )
        return result.stdout.strip() == "True"
    except Exception:
        return False


def zip_directory(src_dir: Path, zip_path: Path):
    """Zip the contents of src_dir into zip_path (no top-level wrapper folder)."""
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for root, _, files in os.walk(src_dir):
            for name in files:
                full = Path(root) / name
                arc = full.relative_to(src_dir)
                zf.write(full, arc)


def main():
    cuda = "--cuda" in sys.argv
    release = "--release" in sys.argv
    triple = target_triple()
    is_windows = platform.system().lower() == "windows"
    exe_suffix = ".exe" if is_windows else ""

    if release:
        variant = "cuda" if cuda else "cpu"
        zip_name = f"transcribe-{variant}-{triple}.zip"
    else:
        # Dev: copied into src-tauri/binaries/transcribe-{triple}/
        dev_folder_name = f"transcribe-{triple}"

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
    print(f"Mode          : {'release (zipped)' if release else 'dev (folder)'}")
    print()

    # Locate LGPL ffmpeg binaries
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
            "Run 'python sidecar/fetch_ffmpeg.py' first."
        )

    if ffprobe_bin.is_file():
        add_binary_args += ["--add-binary", f"{ffprobe_bin}{os.pathsep}."]
        print(f"Bundling ffprobe: {ffprobe_bin}  ({ffprobe_bin.stat().st_size / 1e6:.1f} MB)")
    else:
        print("WARNING: ffprobe not found — audio stream detection will be skipped.")

    # Clean any previous build to avoid stale files
    onedir_out = DIST_DIR / "transcribe"
    if onedir_out.exists():
        shutil.rmtree(onedir_out)

    cmd = [
        sys.executable, "-m", "PyInstaller",
        # NOTE: no --onefile — onedir mode produces a folder with no runtime extraction.
        "--name", "transcribe",
        "--distpath", str(DIST_DIR),
        "--workpath", str(SCRIPT_DIR / "build"),
        "--specpath", str(SCRIPT_DIR),
        "--collect-all", "whisperx",
        "--collect-all", "faster_whisper",
        "--collect-all", "ctranslate2",
        "--collect-all", "transformers",
        "--collect-all", "pyannote",
        "--copy-metadata", "torchcodec",
        "--copy-metadata", "transformers",
        "--copy-metadata", "whisperx",
        "--copy-metadata", "faster-whisper",
        "--copy-metadata", "torch",
        "--copy-metadata", "torchaudio",
        "--noconsole",
        *add_binary_args,
        str(SCRIPT_DIR / "transcribe.py"),
    ]

    print("Running PyInstaller...")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        sys.exit(f"PyInstaller failed with exit code {result.returncode}")

    if not onedir_out.is_dir():
        sys.exit(f"ERROR: expected PyInstaller output at {onedir_out}, not found")

    # Compute the size of the unpacked folder
    total_bytes = sum(f.stat().st_size for f in onedir_out.rglob("*") if f.is_file())
    print(f"\nBuilt onedir folder: {onedir_out}")
    print(f"Unpacked size: {total_bytes / 1_000_000:.1f} MB")

    if release:
        # Zip the folder for distribution
        zip_path = DIST_DIR / zip_name
        if zip_path.exists():
            zip_path.unlink()
        print(f"\nZipping -> {zip_path} (this may take a minute)...")
        zip_directory(onedir_out, zip_path)
        print(f"Zip size: {zip_path.stat().st_size / 1_000_000:.1f} MB")
    else:
        # Dev: copy onedir folder into src-tauri/binaries/transcribe-{triple}/
        BINARIES_DIR.mkdir(parents=True, exist_ok=True)
        dev_dst = BINARIES_DIR / dev_folder_name
        if dev_dst.exists():
            shutil.rmtree(dev_dst)
        shutil.copytree(onedir_out, dev_dst)
        if not is_windows:
            (dev_dst / "transcribe").chmod(0o755)
        print(f"\nDev folder copied to: {dev_dst}")
        print(f"Binary: {dev_dst / ('transcribe' + exe_suffix)}")


if __name__ == "__main__":
    main()
