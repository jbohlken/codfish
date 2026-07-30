/**
 * Mediabunny-backed media probe: packet-exact duration, frame rate, and
 * decodability for a media path — without the <video> element (whose duration
 * is a demuxer estimate: wrong for VBR MP3, Infinity/NaN for moov-at-end MP4s
 * until enough of the file streams in) and without the sidecar daemon (which
 * probe_fps needs).
 *
 * mediabunny itself is imported dynamically so app startup never pays for it;
 * the chunk loads on the first probe. All reads go through the asset protocol
 * as HTTP range requests (UrlSource) — the reliable path; the historical
 * whole-file-fetch failure doesn't apply because mediabunny never fetches
 * whole files.
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { loadMediabunny } from "./mediabunnyRuntime";

export interface MediaProbe {
  /** Playable content length in seconds (normalized — see normalizeDuration). */
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Snapped average frame rate of the video track, or null (no video). */
  fps: number | null;
  /** True when sampled frame spacing varies — fps is then an average and
   *  frame-snapping is approximate. Mirrors the sidecar probe's vfr flag. */
  vfr: boolean;
  canDecodeVideo: boolean;
  canDecodeAudio: boolean;
  /** Display aspect ratio (after rotation), for filmstrip thumb sizing. */
  aspect: number | null;
}

// Rates the sidecar's ffprobe path also snaps to; averagePacketRate comes back
// as e.g. 29.9700299… for NTSC media and must land on the canonical value or
// SMPTE timecode math drifts.
const COMMON_RATES = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 120];

/** Snap a measured average frame rate to the NEAREST common rate when it's
 *  within 0.05 of one (measurement jitter), else round to 3 decimals (a real
 *  unusual-but-constant rate, or a VFR average). Nearest — not first-within-
 *  tolerance — because neighboring canonical rates (23.976/24, 29.97/30) sit
 *  closer to each other than the tolerance itself. */
export function snapFps(rate: number): number | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const r of COMMON_RATES) {
    const d = Math.abs(rate - r);
    if (d < bestDist) {
      best = r;
      bestDist = d;
    }
  }
  if (best !== null && bestDist <= 0.05) return best;
  return Math.round(rate * 1000) / 1000;
}

/** VFR heuristic over sampled packet timestamps (any order — sorted here into
 *  presentation order, which also neutralizes B-frame decode-order jumps).
 *  Compares the p10–p90 spread of frame-to-frame spacing against the median:
 *  a constant-rate stream has near-zero spread (Matroska's ms-rounded stamps
 *  jitter ~3%), while a real rate change (24→60) blows past it. Percentiles —
 *  not min/max — so a single dropped/duplicated frame in an otherwise constant
 *  stream doesn't read as VFR. 5% tolerance matches the sidecar heuristic. */
export function looksVfr(timestamps: number[]): boolean {
  if (timestamps.length < 9) return false;
  const sorted = [...timestamps].sort((a, b) => a - b);
  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d > 0) deltas.push(d); // ignore duplicate-timestamp packets
  }
  if (deltas.length < 8) return false;
  deltas.sort((a, b) => a - b);
  const at = (q: number) => deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))];
  const median = at(0.5);
  if (median <= 0) return false;
  // Relative 5% (matches the sidecar) AND an absolute 2 ms floor: containers
  // with a 1 ms timestamp grid (Matroska) make a CFR ≥60 fps stream's deltas
  // alternate by a full millisecond — >5% of a 16.7 ms median but pure
  // quantization. A real rate change dwarfs both thresholds.
  return at(0.9) - at(0.1) > Math.max(0.05 * median, 0.002);
}

/** Content length from mediabunny's file-level numbers. computeDuration() is
 *  the max track end timestamp, which includes the container's start offset —
 *  MPEG-TS streams typically begin at ~1.4s, and AAC-in-MP4 begins slightly
 *  negative (encoder priming). The <video> element (and our timeline) counts
 *  from zero, so subtract a positive start; a negative start is priming that
 *  the element clock never sees — clamp it away. */
export function normalizeDuration(computedDuration: number, firstTimestamp: number): number {
  return Math.max(0, computedDuration - Math.max(firstTimestamp, 0));
}

const cache = new Map<string, { mtime: number; promise: Promise<MediaProbe | null> }>();

/** Probe a media file. Cached per (path, mtime) for the session — an in-place
 *  file replacement (re-export over the same path, cloud-sync update) gets a
 *  fresh probe instead of a stale extent stuck for the session. Failed probes
 *  are evicted so the next selection retries. Never throws. */
export async function probeMedia(path: string): Promise<MediaProbe | null> {
  let mtime = 0;
  try {
    mtime = await invoke<number>("file_mtime", { path });
  } catch {
    // stat failed (missing file / test env) — cache per-path with mtime 0.
  }
  const entry = cache.get(path);
  if (entry && entry.mtime === mtime) return entry.promise;
  const promise = doProbe(path);
  cache.set(path, { mtime, promise });
  void promise.then((result) => {
    if (result === null && cache.get(path)?.promise === promise) cache.delete(path);
  });
  return promise;
}

/** Drop a cached probe (e.g. after a re-link replaces the file at a path). */
export function invalidateProbe(path: string): void {
  cache.delete(path);
}

async function doProbe(path: string): Promise<MediaProbe | null> {
  try {
    const { Input, ALL_FORMATS, UrlSource, EncodedPacketSink } = await loadMediabunny();
    const input = new Input({
      formats: ALL_FORMATS,
      source: new UrlSource(convertFileSrc(path)),
    });
    try {
      // Metadata-first: the container's stated duration (moov, Matroska info,
      // MP3 Xing frame count) is authoritative where present and avoids the
      // full-file packet walk that index-less containers (headerless MP3)
      // need for computeDuration — a probe must stay cheap, it runs on every
      // clip selection. Only fall back to the exact packet walk when the
      // container states nothing.
      const duration = (await input.getDurationFromMetadata(undefined, { skipLiveWait: true }))
        ?? (await input.computeDuration(undefined, { skipLiveWait: true }));
      const firstTs = await input.getFirstTimestamp();
      const video = await input.getPrimaryVideoTrack();
      const audio = await input.getPrimaryAudioTrack();

      let fps: number | null = null;
      let vfr = false;
      let aspect: number | null = null;
      let canDecodeVideo = false;
      if (video) {
        // ~120 packets ≈ 4–5 s of video: enough to average out B-frame jitter
        // without reading a long file end-to-end.
        const stats = await video.computePacketStats(120);
        fps = snapFps(stats.averagePacketRate);
        // Same sample window, metadata only (no packet payloads read).
        const packetSink = new EncodedPacketSink(video);
        const stamps: number[] = [];
        for await (const packet of packetSink.packets(undefined, undefined, { metadataOnly: true })) {
          stamps.push(packet.timestamp);
          if (stamps.length >= 120) break;
        }
        vfr = looksVfr(stamps);
        const w = await video.getDisplayWidth();
        const h = await video.getDisplayHeight();
        aspect = h > 0 ? w / h : null;
        canDecodeVideo = await video.canDecode();
      }
      const canDecodeAudio = audio ? await audio.canDecode() : false;

      return {
        duration: normalizeDuration(duration, firstTs),
        hasVideo: video !== null,
        hasAudio: audio !== null,
        fps,
        vfr,
        canDecodeVideo,
        canDecodeAudio,
        aspect,
      };
    } finally {
      input.dispose();
    }
  } catch {
    return null;
  }
}
