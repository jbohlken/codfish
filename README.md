# Codfish

A desktop caption editor built with Tauri + Preact. Transcribes audio/video using WhisperX and lets you edit, time, and export captions.

## Development

```bash
npm install
npm run tauri dev
```

## Building

### 1. Set up the sidecar Python environment

The transcription sidecar uses PyInstaller. You need a Python environment with the required packages.

**CPU build** (works on any machine):
```bash
python -m venv sidecar/.venv
sidecar\.venv\Scripts\activate        # Windows
# source sidecar/.venv/bin/activate   # macOS/Linux
pip install -r sidecar/requirements.txt
```

**CUDA build** (requires an Nvidia GPU with CUDA installed):
```bash
python -m venv sidecar/.venv-cuda
sidecar\.venv-cuda\Scripts\activate        # Windows
# source sidecar/.venv-cuda/bin/activate   # macOS/Linux
pip install -r sidecar/requirements-cuda.txt
```

The CUDA build requires [CUDA Toolkit](https://developer.nvidia.com/cuda-downloads) to be installed on the build machine. `requirements-cuda.txt` installs PyTorch with CUDA 12.1 support — adjust the index URL for other CUDA versions.

### 2. Build the sidecar binary

Make sure the appropriate venv is active first.

```bash
# CPU
python sidecar/build.py

# CUDA
python sidecar/build.py --cuda
```

The script validates that `torch.cuda.is_available()` before proceeding — it will fail fast with a clear error if CUDA isn't set up correctly.

### 3. Build the app installer

```bash
npm run tauri build
```

Output: `src-tauri/target/release/bundle/nsis/Codfish_<version>_x64-setup.exe`

The installer is large (~several GB) because WhisperX and PyTorch are bundled into the sidecar binary.

### Notes

- The venv only needs to be active for the `python sidecar/build.py` step. `npm run tauri build` is independent.
- `build.py` places the sidecar binary in `src-tauri/binaries/` automatically.
- End users need a modern Nvidia driver (418+) for GPU acceleration — the CUDA runtime is bundled with it.
