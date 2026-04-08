# Security

## Reporting a vulnerability

If you find a security issue in Codfish, please report it privately rather than opening a public GitHub issue. Open a [private security advisory](https://github.com/jbohlken/codfish/security/advisories/new) with:

- A description of the issue
- Steps to reproduce
- The affected version (or commit)
- Any suggested mitigation

Expect an acknowledgement within a few days. As a solo-maintained project, response times are best-effort.

## Supported versions

Only the latest released version of Codfish receives security fixes. Older releases are not patched.

## What Codfish handles

Codfish is a **local-only desktop application**. The user's media files, transcripts, project files, and recovery snapshots are processed and stored entirely on the user's machine. None of this data is transmitted to any server operated by the project or any third party.

### Data at rest

| Data | Location |
|---|---|
| Project files (`.cod`) | Wherever the user saves them |
| Recovery snapshots | OS-standard app data directory |
| Waveform peaks cache | OS-standard app data directory |
| Logs | OS-standard app data directory |
| Bundled transcription engine | OS-standard app data directory |

All paths are user-scoped. Uninstalling the app and clearing the app data directory removes all Codfish-related data.

### Network calls

Codfish makes the following network calls, and **only** these:

1. **Update check** — On startup, queries `github.com/jbohlken/codfish/releases` for a newer app version. No user data is sent; this is an unauthenticated GET.
2. **Sidecar download** — On first launch (or when a new sidecar version is available), downloads the transcription engine binary from a `github.com/jbohlken/codfish/releases` asset URL. No user data is sent.
3. **Bug report submission** — Only when the user explicitly clicks the in-app "Report a bug" or "Request a feature" button and submits the form. The submission contains: the user's typed description, optionally an attached log file the user explicitly chose to attach, and the app version. It is sent to the project's GitHub Issues via a fine-grained GitHub Personal Access Token scoped to that single repository's Issues API. No project files, media, or transcripts are transmitted.

There are **no analytics, no telemetry, and no third-party tracking** of any kind.

## Update integrity

App updates are distributed via Tauri's built-in updater. Each release artifact is signed with a Minisign private key held only in the project's GitHub Actions secrets. The installed app verifies the signature against an embedded public key before applying any update. Tampered or unsigned update artifacts are rejected.

## Build provenance

All releases are built by GitHub Actions from public source. The workflows that produce releases are:

- [`.github/workflows/release-app.yml`](.github/workflows/release-app.yml) — app installers (Windows NSIS, macOS DMG)
- [`.github/workflows/release-sidecar.yml`](.github/workflows/release-sidecar.yml) — transcription engine
- [`.github/workflows/build-ffmpeg.yml`](.github/workflows/build-ffmpeg.yml) — bundled minimal LGPL ffmpeg

The CUDA sidecar variant is built and uploaded manually from the maintainer's Windows machine, as documented in the README. This step is not currently reproducible from CI.

## Bundled binaries

Codfish bundles ffmpeg + ffprobe for media decoding. These are built from upstream ffmpeg source with `--disable-gpl --disable-nonfree` flags, producing a minimal LGPL-only build with no GPL components. See [`sidecar/build_ffmpeg.sh`](sidecar/build_ffmpeg.sh) for the exact configure flags and [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) for the full bundled-software inventory.

## Credentials embedded in the binary

The app embeds a fine-grained GitHub Personal Access Token (`CODFISH_GH_PAT`) used solely by the bug reporter to file issues against the Codfish repository. The token is XOR-encoded (not encrypted) in the binary at compile time. Its scope is limited to **read/write Issues on the `jbohlken/codfish` repository only** — it cannot read code, modify other repositories, or access user data on GitHub. If the token is ever extracted and abused, the impact is bounded to spam issues on the Codfish repository, which can be revoked and rotated.

## Sole-maintainer risk

Codfish is currently maintained by one person. If maintenance lapses, the source is openly available under Apache-2.0 and may be forked and continued by anyone.
