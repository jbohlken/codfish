# Third-Party Licenses

Codfish is licensed under Apache-2.0 (see [LICENSE](LICENSE)). It bundles
or depends on the following third-party software, each under its own
license.

Full license texts for every bundled dependency are generated at build
time and shipped inside the distributed binaries. This document describes
the process and lists the key components.

## How license texts are collected

Codfish ships two binaries — the desktop app and the transcription
sidecar — each with its own dependency tree.

### Transcription sidecar (Python)

The sidecar is built with PyInstaller. During the build
(`sidecar/build.py`), `sidecar/collect_licenses.py` runs `pip-licenses`
to extract the full license text for every installed Python package and
writes `THIRD_PARTY_LICENSES.txt` into the bundle directory. This file
ships alongside the `transcribe` binary.

Key dependencies:

| Package         | License            |
|-----------------|--------------------|
| whisperx        | BSD-2-Clause       |
| faster-whisper  | MIT                |
| ctranslate2     | MIT                |
| torch           | BSD-3-Clause       |
| torchaudio      | BSD-2-Clause       |
| transformers    | Apache-2.0         |
| tokenizers      | Apache-2.0         |
| huggingface_hub | Apache-2.0         |
| pyannote.audio  | MIT                |
| numpy           | BSD-3-Clause       |
| scipy           | BSD-3-Clause       |
| librosa         | ISC                |
| soundfile       | BSD-3-Clause       |

To regenerate locally:

```sh
pip install pip-licenses
python sidecar/collect_licenses.py --out sidecar/THIRD_PARTY_LICENSES.txt
```

### Desktop app — Rust crates

The Tauri shell and its Rust dependencies are collected with
[cargo-about](https://github.com/EmbarkStudios/cargo-about). The
configuration and template live at `src-tauri/about.toml` and
`src-tauri/about.hbs`.

To regenerate locally:

```sh
cargo install cargo-about
cargo about generate -c src-tauri/about.toml src-tauri/about.hbs > THIRD_PARTY_LICENSES_RUST.txt
```

### Desktop app — npm packages

Frontend npm dependencies (Preact, wavesurfer.js, Tauri JS bindings,
etc.) are compiled into the app's JS bundle. Their license texts are
collected with `license-checker-rspack`.

To regenerate locally:

```sh
node scripts/collect-npm-licenses.js THIRD_PARTY_LICENSES_NPM.txt
```

## Bundled binaries

### ffmpeg / ffprobe — LGPL-2.1-or-later

Codfish bundles a minimal ffmpeg + ffprobe build for media decoding. The
binaries are built from upstream ffmpeg source with `--disable-gpl` and
`--disable-nonfree`, producing an LGPL-only build. See
[sidecar/build_ffmpeg.sh](sidecar/build_ffmpeg.sh) for the exact configure
flags and [.github/workflows/build-ffmpeg.yml](.github/workflows/build-ffmpeg.yml)
for the CI pipeline that produces them.

Per LGPL terms, you have the right to replace the bundled ffmpeg binary
with your own LGPL-compatible build. The ffmpeg binaries ship as separate
executables alongside the sidecar (not statically linked into it) to
preserve this right.

ffmpeg source: https://ffmpeg.org/
ffmpeg license: https://www.ffmpeg.org/legal.html

### PyInstaller runtime

PyInstaller is GPL with an explicit bootloader/runtime exception that
clarifies that frozen applications are not derivative works of
PyInstaller. Codfish uses PyInstaller as a build tool only.

## Artwork

The Codfish app icon is based on a fish illustration from
[SVG Repo](https://www.svgrepo.com/svg/65669/fish), released under
CC0 (public domain dedication). No attribution is required by CC0;
this credit is provided as a courtesy.

## Trademarks

"Codfish" is a trademark of Jared Bohlken. The Apache-2.0 license under
which the source code is distributed does not grant permission to use
the Codfish name in derivative works or forks. If you fork this project,
please use a different name.
