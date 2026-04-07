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
#   sidecar/build_ffmpeg.sh                   # uses default FFMPEG_VERSION
#   FFMPEG_VERSION=n7.1 sidecar/build_ffmpeg.sh
#
# Requirements (macOS):
#   xcode-select --install
#   brew install nasm pkg-config
#
# Requirements (Linux):
#   apt install build-essential nasm pkg-config

set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-n7.1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_ROOT="${SCRIPT_DIR}/build/ffmpeg-src"
OUT_DIR="${SCRIPT_DIR}/ffmpeg"
SRC_DIR="${BUILD_ROOT}/ffmpeg-${FFMPEG_VERSION}"

mkdir -p "${BUILD_ROOT}" "${OUT_DIR}"

if [ ! -d "${SRC_DIR}" ]; then
  echo "Cloning ffmpeg ${FFMPEG_VERSION}..."
  git clone --depth 1 --branch "${FFMPEG_VERSION}" \
    https://git.ffmpeg.org/ffmpeg.git "${SRC_DIR}"
else
  echo "Using existing source at ${SRC_DIR}"
fi

cd "${SRC_DIR}"

# Clean any prior build artifacts in the source tree.
make distclean >/dev/null 2>&1 || true

echo "Configuring ffmpeg (LGPL, audio-only, minimal)..."

./configure \
  --prefix="${SRC_DIR}/install" \
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
cp "${SRC_DIR}/install/bin/ffmpeg" "${OUT_DIR}/ffmpeg"
cp "${SRC_DIR}/install/bin/ffprobe" "${OUT_DIR}/ffprobe"
chmod +x "${OUT_DIR}/ffmpeg" "${OUT_DIR}/ffprobe"

echo
echo "Done."
echo "  ffmpeg:  $(ls -lh "${OUT_DIR}/ffmpeg"  | awk '{print $5}')"
echo "  ffprobe: $(ls -lh "${OUT_DIR}/ffprobe" | awk '{print $5}')"
echo
echo "Verify license + config with:"
echo "  ${OUT_DIR}/ffmpeg -version"
