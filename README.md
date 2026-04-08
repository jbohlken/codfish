# Codfish

A desktop caption editor built with Tauri v2 + Preact. Transcribes audio/video using WhisperX and lets you edit, time, and export captions.

## Architecture

- **App** (Tauri/Rust + Preact) — the editor UI and file management
- **Sidecar** (Python/PyInstaller) — the transcription engine, downloaded on first launch
- The app and sidecar are versioned independently (`v*` and `sidecar-v*` tags)
- The sidecar ships in three variants: CPU (Windows), CPU (macOS arm64), and CUDA (Windows)
- GPU detection happens at install time — users with Nvidia GPUs get the CUDA variant

## Development

### Prerequisites

- Node.js 20+
- Rust (via [rustup](https://rustup.rs/))
- Windows: no extra requirements
- macOS: Xcode Command Line Tools (`xcode-select --install`)

### Running locally

```bash
npm install
npx tauri dev
```

The app will show the sidecar setup screen if no sidecar binary is installed. For local sidecar development, build it with `python sidecar/build.py` (see below) — this places the binary in `src-tauri/binaries/` for Tauri to find.

### Sidecar development

```bash
python -m venv sidecar/.venv-cpu
# Windows: sidecar\.venv-cpu\Scripts\activate
# macOS:   source sidecar/.venv-cpu/bin/activate
pip install -r sidecar/requirements.txt
python sidecar/fetch_ffmpeg.py
python sidecar/build.py
```

For CUDA builds:

```bash
python -m venv sidecar/.venv-cuda
# Windows: sidecar\.venv-cuda\Scripts\activate
pip install -r sidecar/requirements-cuda.txt
python sidecar/fetch_ffmpeg.py
python sidecar/build.py --cuda
```

## Releasing

### App release

1. Bump version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`
2. Run `cargo update --workspace` in `src-tauri/`
3. Commit, tag, and push:
   ```bash
   git tag v0.5.6
   git push origin main v0.5.6
   ```
4. CI builds Windows (NSIS) and macOS (DMG) installers and creates a draft release
5. Publish the draft on GitHub

### Sidecar release

1. Commit any sidecar changes and push
2. Tag and push:
   ```bash
   git tag sidecar-v0.1.1
   git push origin sidecar-v0.1.1
   ```
3. CI builds Windows + macOS CPU variants and creates a draft release
4. Add the CUDA variant from your Windows PC:
   ```bash
   sidecar\.venv-cuda\Scripts\activate
   python sidecar/release-cuda.py --version 0.1.1
   ```
5. Publish the draft on GitHub

Release the sidecar before the app so new sidecar features are available when users update.

## CI/CD

### Workflows

- **Release App** (`.github/workflows/release-app.yml`) — triggered by `v*` tags, builds Windows + macOS
- **Release Sidecar** (`.github/workflows/release-sidecar.yml`) — triggered by `sidecar-v*` tags, builds CPU variants

### Required secrets

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Minisign private key for update signing |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the signing key |
| `CODFISH_GH_PAT` | Fine-grained PAT (Issues: read/write) for in-app bug reporter |

### Build-time environment

The app reads `CODFISH_GH_PAT` at compile time (via `src-tauri/.env` locally, or the CI secret). It is XOR-encoded into the binary — never stored as plaintext in source.

## macOS notes

- Unsigned builds require `xattr -cr /Applications/Codfish.app` or System Settings > Privacy & Security > Open Anyway
- macOS Sequoia removed the right-click > Open workaround for unsigned apps
- An Apple Developer account ($99/yr) eliminates these warnings via code signing and notarization
- ffmpeg is fetched as a prebuilt LGPL binary (from the `ffmpeg-*-codfish.*` release) and bundled into the sidecar — no Homebrew ffmpeg needed
