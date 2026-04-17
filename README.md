# Codfish

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

A desktop caption editor built with Tauri v2 + Preact. Transcribes audio/video using WhisperX and lets you edit, time, and export captions.

## Architecture

- **App** (Tauri/Rust + Preact) — the editor UI and file management
- **Sidecar** (Python/PyInstaller) — the transcription engine, downloaded on first launch
- The app and sidecar are versioned independently (`v*` and `sidecar-v*` tags)
- The sidecar ships in three variants: CPU (Windows), CPU (macOS arm64), and CUDA (Windows)
- Users choose CPU or CUDA variant during sidecar setup

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

Verify a build with `sidecar/dist/transcribe/transcribe --version`. The version is defined in `sidecar/transcribe.py` (`VERSION` constant) and should match the tag passed to `make_manifest.py` at release time.

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
3. CI builds Windows + macOS CPU variants and the Windows CUDA variant, and creates a draft release
4. Publish the draft on GitHub

Release the sidecar before the app so new sidecar features are available when users update.

## CI/CD

### Workflows

- **Release App** (`.github/workflows/release-app.yml`) — triggered by `v*` tags, builds Windows + macOS, signs both (Azure Trusted Signing on Windows, Apple notarization on macOS)
- **Release Sidecar** (`.github/workflows/release-sidecar.yml`) — triggered by `sidecar-v*` tags, builds CPU variants

### Required secrets

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Minisign private key for update signing |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the signing key |
| `CODFISH_GH_PAT` | Fine-grained PAT (Issues: read/write) for in-app bug reporter |
| `AZURE_CLIENT_ID` | Azure service principal for Windows code signing |
| `AZURE_TENANT_ID` | Azure AD tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |
| `APPLE_CERTIFICATE` | Apple Developer certificate (.p12 base64) |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the .p12 certificate |
| `APPLE_SIGNING_IDENTITY` | Apple signing identity (Developer ID Application) |
| `APPLE_ID` | Apple ID for notarization |
| `APPLE_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

### Build-time environment

The app reads `CODFISH_GH_PAT` at compile time (via `src-tauri/.env` locally, or the CI secret). It is XOR-encoded into the binary — never stored as plaintext in source.

## Code signing

- **Windows** — Release builds are signed via [Azure Trusted Signing](https://azure.microsoft.com/en-us/products/trusted-signing) using OIDC federated credentials (no secrets to rotate). Signed installers get immediate SmartScreen trust.
- **macOS** — Release builds are signed and notarized via Apple Developer ID. No quarantine warnings on install.

### macOS development notes

- Dev builds (unsigned) require `xattr -cr /Applications/Codfish.app` or System Settings > Privacy & Security > Open Anyway
- macOS Sequoia removed the right-click > Open workaround for unsigned apps
- ffmpeg is fetched as a prebuilt LGPL binary (from the `ffmpeg-*-codfish.*` release) and bundled into the sidecar — no Homebrew ffmpeg needed

## License

Codfish is licensed under the [Apache License 2.0](LICENSE). You are free to use, modify, and redistribute the source code under those terms.

Bundled and dependent components are licensed separately — see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md). Notably, the bundled ffmpeg is built from source under LGPL terms with no GPL components.

## Trademark

"Codfish" is a trademark of Jared Bohlken. The Apache-2.0 license grants rights to the source code only — it does **not** grant permission to use the Codfish name in derivative works or forks. If you fork this project, please use a different name.

## Support the project

Codfish is built and maintained by one person in their spare time. If it's useful to you, consider [sponsoring the project on GitHub](https://github.com/sponsors/jbohlken). Sponsorships are what make continued development possible.
