# Third-Party Licenses

Codfish is licensed under Apache-2.0 (see [LICENSE](LICENSE)). It bundles
or depends on the following third-party software, each under its own
license. This document is a summary; the authoritative license text for
each component is included with that component's source or distribution.

## Bundled binaries (shipped inside the installer)

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

## Sidecar Python dependencies

The transcription sidecar is bundled into a single executable via
PyInstaller. The runtime dependencies and their licenses:

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

PyInstaller is GPL with an explicit bootloader/runtime exception that
clarifies that frozen applications are not derivative works of
PyInstaller. Codfish uses PyInstaller as a build tool only.

## App / desktop shell dependencies

The Tauri desktop shell and its Rust crates are licensed under MIT or
Apache-2.0. The Preact frontend and its npm dependencies are similarly
permissive (MIT, ISC, Apache-2.0, BSD).

A complete machine-generated inventory of Rust crate licenses can be
produced with `cargo about` (recommended for releases).

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
