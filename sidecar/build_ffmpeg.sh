#!/usr/bin/env bash
#
# Build a minimal LGPL ffmpeg + ffprobe from source for bundling with the
# Codfish sidecar. Drops the resulting binaries into sidecar/ffmpeg/.
#
# Why we build from source:
#   - Homebrew's ffmpeg formula is GPL (--enable-gpl), which is incompatible
#     with shipping under Apache-2.0. There is no maintained prebuilt LGPL
#     macOS ffmpeg, so we build it ourselves.
#   - Building lets us strip ffmpeg down to only the demuxers/decoders
#     Codfish actually needs (audio only, no video, no network), which also
#     shrinks the binary from ~80 MB to ~10 MB.
#
# Usage:
#   sidecar/build_ffmpeg.sh                       # native build for current OS
#   FFMPEG_VERSION=n7.1 sidecar/build_ffmpeg.sh
#   TARGET=windows sidecar/build_ffmpeg.sh        # cross-compile to Windows x64
#                                                 # (run on Linux only)
#
# Requirements (macOS):
#   xcode-select --install
#   brew install nasm pkg-config
#
# Requirements (Linux native):
#   apt install build-essential nasm pkg-config
#
# Requirements (Linux → Windows cross-compile):
#   apt install build-essential nasm pkg-config mingw-w64

set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-n7.1}"
TARGET="${TARGET:-native}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_ROOT="${SCRIPT_DIR}/build/ffmpeg-src"
OUT_DIR="${SCRIPT_DIR}/ffmpeg"
SRC_DIR="${BUILD_ROOT}/ffmpeg-${FFMPEG_VERSION}-${TARGET}"

mkdir -p "${BUILD_ROOT}" "${OUT_DIR}"

if [ ! -d "${SRC_DIR}" ]; then
  echo "Cloning ffmpeg ${FFMPEG_VERSION} into ${SRC_DIR}..."
  git clone --depth 1 --branch "${FFMPEG_VERSION}" \
    https://git.ffmpeg.org/ffmpeg.git "${SRC_DIR}"
else
  echo "Using existing source at ${SRC_DIR}"
fi

cd "${SRC_DIR}"

# Clean any prior build artifacts in the source tree.
make distclean >/dev/null 2>&1 || true

# Target-specific configure flags. Native builds add nothing; Windows cross
# adds the mingw-w64 toolchain prefix and target-os hint. The audio/codec
# flag set is identical across targets so we get matching feature parity.
TARGET_FLAGS=()
EXE_SUFFIX=""
case "${TARGET}" in
  native)
    ;;
  windows)
    TARGET_FLAGS=(
      --arch=x86_64
      --target-os=mingw32
      --cross-prefix=x86_64-w64-mingw32-
      --pkg-config=pkg-config
    )
    EXE_SUFFIX=".exe"
    ;;
  *)
    echo "Unknown TARGET=${TARGET} (expected 'native' or 'windows')" >&2
    exit 1
    ;;
esac

echo "Configuring ffmpeg (LGPL, audio-only, minimal, target=${TARGET})..."

./configure \
  --prefix="${SRC_DIR}/install" \
  "${TARGET_FLAGS[@]}" \
  --disable-gpl \
  --disable-nonfree \
  --disable-doc \
  --disable-debug \
  --disable-htmlpages --disable-manpages --disable-podpages --disable-txtpages \
  --disable-network \
  --disable-autodetect \
  --disable-everything \
  --enable-small \
  --enable-static --disable-shared \
  --enable-pic \
  \
  --enable-demuxer=mov,matroska,avi,wav,mp3,aac,flac,ogg,aiff,m4a,matroska_audio,webm_dash_manifest \
  \
  --enable-decoder=aac,aac_latm,mp3,mp3float,flac,vorbis,opus,alac,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_u8,pcm_s8,pcm_mulaw,pcm_alaw \
  \
  --enable-parser=aac,aac_latm,mpegaudio,flac,vorbis,opus \
  \
  --enable-protocol=file,pipe \
  \
  --enable-filter=aresample,aformat,anull,atrim,volume \
  --enable-swresample \
  \
  --enable-encoder=pcm_s16le \
  --enable-muxer=wav,s16le,pcm_s16le \
  \
  --enable-ffmpeg \
  --enable-ffprobe \
  --disable-ffplay

echo "Building (this takes several minutes)..."
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

echo "Installing into ${SRC_DIR}/install ..."
make install

echo "Copying binaries into ${OUT_DIR} ..."
cp "${SRC_DIR}/install/bin/ffmpeg${EXE_SUFFIX}"  "${OUT_DIR}/ffmpeg${EXE_SUFFIX}"
cp "${SRC_DIR}/install/bin/ffprobe${EXE_SUFFIX}" "${OUT_DIR}/ffprobe${EXE_SUFFIX}"
chmod +x "${OUT_DIR}/ffmpeg${EXE_SUFFIX}" "${OUT_DIR}/ffprobe${EXE_SUFFIX}"

echo
echo "Done."
echo "  ffmpeg${EXE_SUFFIX}:  $(ls -lh "${OUT_DIR}/ffmpeg${EXE_SUFFIX}"  | awk '{print $5}')"
echo "  ffprobe${EXE_SUFFIX}: $(ls -lh "${OUT_DIR}/ffprobe${EXE_SUFFIX}" | awk '{print $5}')"
echo
echo "Verify license + config with:"
echo "  ${OUT_DIR}/ffmpeg -version"
