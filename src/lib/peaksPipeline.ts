/**
 * The waveform peaks pipeline, lifted out of the Timeline effect so its
 * decision tree is unit-testable with plain fakes: cache hit → in-process
 * mediabunny decode → sidecar ffmpeg fallback, with a cancellation checkpoint
 * between every stage. The two bugs that shipped from this logic when it
 * lived inline (swapped reducer args; the AAC-padding axis stretch) are
 * exactly the class a branch-level suite catches.
 *
 * The Timeline supplies real dependencies (IndexedDB cache, Rust invokes,
 * element-clock wait); tests supply fakes. This module reads no signals.
 */
import { desiredBinsPerSec } from "./peaks-cache";
import type { GeneratedPeaks } from "./peaksMediabunny";

export interface PeaksPipelineDeps {
  /** File modification time in unix seconds (Rust file_mtime). */
  getMtime(path: string): Promise<number>;
  /** Cache lookup keyed (path, mtime); null on miss. */
  getCached(path: string, mtime: number): Promise<{ peaks: Float32Array; duration: number } | null>;
  /** Best-effort cache write. */
  cache(path: string, mtime: number, peaks: Float32Array, duration: number, binsPerSec: number): void;
  /** In-process mediabunny decode; null = declined (unreadable/undecodable) or
   *  cancelled mid-decode. Never throws. */
  generateInProcess(path: string, isCancelled: () => boolean): Promise<GeneratedPeaks | null>;
  /** Sidecar ffmpeg decode; throws when the daemon is down or ffmpeg errors. */
  generateSidecar(path: string, binsPerSec: number): Promise<{ peaks: number[]; duration: number }>;
  /** Element-clock duration for the sidecar density policy; null on timeout.
   *  Only awaited on the sidecar branch — the cache and in-process paths
   *  don't need the element at all. */
  waitForElementDuration(): Promise<number | null>;
  log(message: string): void;
}

export interface PeaksResult {
  peaks: Float32Array;
  duration: number;
  source: "cache" | "mediabunny" | "sidecar";
}

/**
 * Resolve peaks for `path`. Resolves null when cancelled (the caller writes no
 * signals); THROWS on hard failure — both generators unavailable — so the
 * caller can surface the failed state. A generation that completes despite
 * cancellation is still cached (the work isn't thrown away); only the return
 * is suppressed.
 */
export async function loadPeaks(
  path: string,
  isCancelled: () => boolean,
  deps: PeaksPipelineDeps,
): Promise<PeaksResult | null> {
  const mtime = await deps.getMtime(path);
  if (isCancelled()) return null;

  // Look up by (path, mtime) only — independent of density, so a stale
  // <video> duration on a media switch can't cause a spurious miss.
  const cached = await deps.getCached(path, mtime);
  if (isCancelled()) return null;
  if (cached) {
    deps.log(`cache hit bins=${cached.peaks.length}`);
    return { peaks: cached.peaks, duration: cached.duration, source: "cache" };
  }

  // In-process first: mediabunny decodes at the native sample rate (the
  // sidecar pipe is 8 kHz mono), derives its own exact duration for the
  // density policy, and doesn't need the daemon to be up.
  const mb = await deps.generateInProcess(path, isCancelled);
  if (mb) {
    deps.cache(path, mtime, mb.peaks, mb.duration, mb.binsPerSec);
    if (isCancelled()) return null;
    deps.log(`mediabunny peaks bins=${mb.peaks.length} duration=${mb.duration.toFixed(2)}s`);
    return { peaks: mb.peaks, duration: mb.duration, source: "mediabunny" };
  }
  if (isCancelled()) return null;

  // Sidecar fallback. Density scales with duration (denser bins for shorter
  // files); the element clock is only consulted here — the painter is
  // density-agnostic, so an approximate value is fine.
  const videoDuration = await deps.waitForElementDuration();
  if (isCancelled()) return null;
  const binsPerSec = desiredBinsPerSec(videoDuration);
  deps.log(`mediabunny declined → generate_peaks binsPerSec=${binsPerSec}`);
  const r = await deps.generateSidecar(path, binsPerSec);
  const peaks = new Float32Array(r.peaks);
  deps.cache(path, mtime, peaks, r.duration, binsPerSec);
  if (isCancelled()) return null;
  deps.log(`generated bins=${peaks.length} duration=${r.duration.toFixed(2)}s`);
  return { peaks, duration: r.duration, source: "sidecar" };
}
