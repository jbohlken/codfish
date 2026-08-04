/**
 * Timeline filmstrip: a viewport-sized, position:sticky canvas lane showing
 * video thumbnails across the clip — same painter architecture as waveform.ts
 * (repaint cost O(viewport) regardless of zoom; repaints coalesced per frame;
 * triggered by scroll, row resize, and thumbnail arrivals).
 *
 * Thumbnails decode on demand via mediabunny's CanvasSink (sparse
 * canvasesAtTimestamps — the battery measured ~5–30 ms per thumb) and are cached
 * by frame-quantized timestamp, so panning/zooming reuses frames instead of
 * re-decoding. Decode requests are batched: each round asks for whatever is
 * visible-and-missing right now, so a zoom mid-load simply redirects the next
 * round rather than filling a stale queue.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { loadMediabunny } from "./mediabunnyRuntime";
import { getCachedThumbs, cacheThumb, pruneStaleThumbs } from "./thumbs-cache";

// ── Pure slot/key math (unit-tested; the painter calls these) ────────────────

/** Thumb slot width for a lane of `rowHeightPx` showing `aspect` (w/h) frames.
 *  Floor of 24px keeps degenerate aspects from creating thousands of slots. */
export function slotWidthPx(rowHeightPx: number, aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  return Math.max(24, Math.round(rowHeightPx * a));
}

/** Slots whose pixel span intersects the viewport, clamped to the content. */
export function visibleSlotRange(
  scrollLeftPx: number,
  viewWidthPx: number,
  totalWidthPx: number,
  slotWPx: number,
): { first: number; last: number } {
  const count = Math.max(1, Math.ceil(totalWidthPx / slotWPx));
  const first = Math.max(0, Math.floor(scrollLeftPx / slotWPx));
  const last = Math.min(count - 1, Math.floor((scrollLeftPx + Math.max(viewWidthPx, 1) - 1) / slotWPx));
  return { first, last: Math.max(first, last) };
}

/** The media time at a slot's center. */
export function slotCenterTime(slot: number, slotWPx: number, totalWidthPx: number, duration: number): number {
  const t = (((slot + 0.5) * slotWPx) / totalWidthPx) * duration;
  return Math.min(Math.max(0, t), Math.max(0, duration - 1e-4));
}

/** Frame-quantized cache key for a timestamp. Keys are zoom-independent: two
 *  slot centers within the same (capped) frame map to the same key, so a zoom
 *  change reuses decoded thumbs instead of starting over. */
export function thumbKey(time: number, keyFps: number): number {
  return Math.round(time * keyFps);
}

/** Decode timestamp for a key (inverse of thumbKey, clamped into the media). */
export function keyTime(key: number, keyFps: number, duration: number): number {
  return Math.min(Math.max(0, key / keyFps), Math.max(0, duration - 1e-4));
}

/** One thumb per frame is the ceiling; 30/s is plenty above any useful zoom. */
export function clampKeyFps(fps: number | null): number {
  if (!fps || !Number.isFinite(fps) || fps <= 0) return 30;
  return Math.min(30, Math.max(1, fps));
}

// ── Thumb source (mediabunny) ────────────────────────────────────────────────

export interface ThumbSource {
  /** Display aspect ratio (w/h, post-rotation). */
  aspect: number;
  /** Frame-quantization rate for cache keys. */
  keyFps: number;
  /** Decode frames at (or just before) the given timestamps, in order. */
  canvasesAt(times: number[]): AsyncGenerator<{ timestamp: number; canvas: HTMLCanvasElement | OffscreenCanvas } | null, void, unknown>;
  dispose(): void;
}

/** Open a media file for thumbnail decoding. `heightPx` is the device-pixel
 *  height thumbs are rendered at. Resolves null when the file has no decodable
 *  video track (the Timeline just doesn't show the lane). Never throws. */
export async function createThumbSource(path: string, heightPx: number): Promise<ThumbSource | null> {
  try {
    const { Input, ALL_FORMATS, UrlSource, CanvasSink } = await loadMediabunny();
    const input = new Input({
      formats: ALL_FORMATS,
      source: new UrlSource(convertFileSrc(path)),
    });
    try {
      const video = await input.getPrimaryVideoTrack();
      if (!video || !(await video.canDecode())) {
        input.dispose();
        return null;
      }
      const w = await video.getDisplayWidth();
      const h = await video.getDisplayHeight();
      const stats = await video.computePacketStats(120);
      // The timeline's axis starts at zero but the track's own timestamps may
      // not (MPEG-TS starts ~1.4 s) — offset requests into track time, like
      // the peaks path. Negative starts (AAC-priming class) clamp to zero.
      const firstTs = Math.max(await video.getFirstTimestamp(), 0);
      const sink = new CanvasSink(video, { height: Math.max(16, Math.round(heightPx)), fit: "contain" });
      return {
        aspect: h > 0 ? w / h : 16 / 9,
        keyFps: clampKeyFps(stats.averagePacketRate),
        canvasesAt: (times) => sink.canvasesAtTimestamps(times.map((t) => t + firstTs)),
        dispose: () => input.dispose(),
      };
    } catch (e) {
      input.dispose(); // a failed track/stat call must not leak the Input
      throw e;
    }
  } catch {
    return null;
  }
}

// ── Painter ──────────────────────────────────────────────────────────────────

// Cap on cached thumbs. Rough memory math: 78×44 CSS px at 2x dpr ≈ 55 KB
// RGBA each → ~33 MB at the cap. Eviction is selective (offscreen entries
// first, FIFO), never wholesale — visible thumbs must not vanish mid-scroll.
const CACHE_CAP = 600;
const BATCH = 24;      // thumbs per decode round; each round re-reads the viewport

export interface FilmstripPainter {
  setLayoutDuration(seconds: number): void;
  schedulePaint(): void;
  destroy(): void;
}

export function createFilmstripPainter(opts: {
  canvas: HTMLCanvasElement;
  /** Outer scroll container — provides scrollLeft, viewport and content width. */
  scrollEl: HTMLElement;
  /** Full-width filmstrip row — provides the row height. */
  rowEl: HTMLElement;
  source: ThumbSource;
  /** When present, thumbs persist to IndexedDB keyed (path, mtime, heightPx)
   *  and re-opening the clip paints from the store instead of re-decoding.
   *  heightPx must match the sink height the source decodes at. */
  persist?: { path: string; mtime: number; heightPx: number };
}): FilmstripPainter {
  const { canvas, scrollEl, rowEl, source, persist } = opts;
  const ctx = canvas.getContext("2d");
  if (persist) pruneStaleThumbs(persist.path, persist.mtime);

  let layoutDuration = 0;
  let raf = 0;
  let destroyed = false;
  let loading = false;
  // key → decoded thumb, or null for "asked, no frame there" (don't re-ask).
  const cache = new Map<number, HTMLCanvasElement | OffscreenCanvas | ImageBitmap | null>();
  const closeThumb = (t: HTMLCanvasElement | OffscreenCanvas | ImageBitmap | null | undefined) => {
    if (t instanceof ImageBitmap) t.close();
  };
  let liveIterator: AsyncGenerator<unknown, void, unknown> | null = null;

  /** Keys for currently visible slots, in paint order. */
  const visibleKeys = (): number[] => {
    if (layoutDuration <= 0) return [];
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const totalW = scrollEl.scrollWidth * dpr;
    const slotW = slotWidthPx(rowEl.clientHeight, source.aspect) * dpr;
    if (totalW <= 0 || slotW <= 0) return [];
    const { first, last } = visibleSlotRange(scrollEl.scrollLeft * dpr, scrollEl.clientWidth * dpr, totalW, slotW);
    const keys: number[] = [];
    for (let s = first; s <= last; s++) {
      const key = thumbKey(slotCenterTime(s, slotW, totalW, layoutDuration), source.keyFps);
      if (!keys.includes(key)) keys.push(key);
    }
    return keys;
  };

  const paint = () => {
    if (!ctx || destroyed) return;
    const viewWidth = scrollEl.clientWidth;
    const rowHeight = rowEl.clientHeight;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.round(viewWidth * dpr);
    const h = Math.round(rowHeight * dpr);
    if (w <= 0 || h <= 0) return;

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${viewWidth}px`;
      canvas.style.height = `${rowHeight}px`;
    } else {
      ctx.clearRect(0, 0, w, h);
    }
    if (layoutDuration <= 0) return;

    const totalW = scrollEl.scrollWidth * dpr;
    const scrollLeft = scrollEl.scrollLeft * dpr;
    const slotW = slotWidthPx(rowHeight, source.aspect) * dpr;
    const { first, last } = visibleSlotRange(scrollLeft, w, totalW, slotW);

    let anyMissing = false;
    for (let s = first; s <= last; s++) {
      const x = s * slotW - scrollLeft;
      const key = thumbKey(slotCenterTime(s, slotW, totalW, layoutDuration), source.keyFps);
      const thumb = cache.get(key);
      if (thumb) {
        // Sink canvases are `fit: contain` at the lane height; width can differ
        // from the slot by a device pixel — stretch to the slot, it's subpixel.
        ctx.drawImage(thumb, x, 0, slotW, h);
      } else if (thumb === undefined) {
        anyMissing = true;
      }
      // Hairline separator so identical neighboring frames still read as slots.
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.fillRect(Math.round(x), 0, 1, h);
    }
    if (anyMissing) void ensureLoading();
  };

  /** Single decode loop: each round asks for what's visible-and-missing NOW,
   *  so zoom/scroll mid-load redirects the next round instead of draining a
   *  stale queue. Stops when a round finds nothing missing. */
  const ensureLoading = async () => {
    if (loading || destroyed) return;
    loading = true;
    try {
      while (!destroyed) {
        const visible = visibleKeys();
        const missing = visible.filter((k) => !cache.has(k)).slice(0, BATCH);
        if (!missing.length) break;
        if (cache.size + missing.length > CACHE_CAP) {
          // Evict offscreen entries in insertion order (oldest first) until the
          // batch fits — never the visible ones, they'd flicker and re-decode.
          const keep = new Set(visible);
          for (const key of cache.keys()) {
            if (cache.size + missing.length <= CACHE_CAP) break;
            if (!keep.has(key)) {
              closeThumb(cache.get(key));
              cache.delete(key);
            }
          }
        }
        // Persistent store first: a re-opened clip paints from IndexedDB
        // without touching the decoder.
        let toDecode = missing;
        if (persist) {
          const stored = await getCachedThumbs(persist.path, persist.mtime, persist.heightPx, missing);
          if (destroyed) {
            for (const bmp of stored.values()) bmp.close();
            return;
          }
          for (const [key, bitmap] of stored) cache.set(key, bitmap);
          if (stored.size) schedulePaint();
          toDecode = missing.filter((k) => !cache.has(k));
          if (!toDecode.length) continue;
        }
        const times = toDecode.map((k) => keyTime(k, source.keyFps, layoutDuration));
        const iterator = source.canvasesAt(times);
        liveIterator = iterator;
        let i = 0;
        for await (const wrapped of iterator) {
          if (destroyed) return;
          const key = toDecode[i++];
          cache.set(key, wrapped ? wrapped.canvas : null);
          if (wrapped && persist) {
            cacheThumb(persist.path, persist.mtime, persist.heightPx, key, wrapped.canvas);
          }
          schedulePaint();
        }
        liveIterator = null;
      }
    } catch {
      // Decode failure (e.g. file vanished mid-session): leave missing slots
      // blank; the next paint retries only if something changes.
    } finally {
      loading = false;
      liveIterator = null;
    }
  };

  const schedulePaint = () => {
    if (raf || destroyed) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      paint();
    });
  };

  scrollEl.addEventListener("scroll", schedulePaint, { passive: true });
  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => paint())
    : null;
  resizeObserver?.observe(rowEl);

  return {
    setLayoutDuration(seconds) {
      if (seconds === layoutDuration) return;
      layoutDuration = seconds;
      schedulePaint();
    },
    schedulePaint,
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      resizeObserver?.disconnect();
      scrollEl.removeEventListener("scroll", schedulePaint);
      void liveIterator?.return();
      for (const thumb of cache.values()) closeThumb(thumb);
      cache.clear();
      source.dispose();
    },
  };
}
