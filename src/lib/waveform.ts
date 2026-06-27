/**
 * Viewport-sized canvas painter for the timeline waveform.
 *
 * Replaces WaveSurfer's renderer, which rasterized the entire zoomed
 * waveform up front (O(zoom × duration) canvas pixels, all rebuilt on
 * every zoom step). The canvas here is viewport-sized and position:sticky
 * at the left edge of the scroll viewport; each repaint draws only the
 * visible portion of the waveform, so per-frame cost is O(viewport)
 * regardless of zoom level or media length.
 *
 * Repaints are coalesced to one per animation frame and triggered by
 * scroll, by row resize (which covers both window resizes and zoom — the
 * row's width is the zoomed content width), and by setPeaks/setLayoutDuration.
 *
 * Peaks and layout duration are set independently: the peaks come from the
 * async sidecar/cache pipeline, while the layout axis tracks the live
 * <video>-clock duration (mediaDuration). Keeping them separate means the
 * painter self-corrects when the duration settles after a media switch,
 * instead of baking in whatever value happened to be current when the
 * pipeline resolved.
 */

/** How the waveform is drawn: discrete bars, or a continuous filled envelope. */
export type WaveformStyle = "bars" | "continuous";

// Bar styling for the "bars" style (CSS px).
const BAR_WIDTH = 2;
const BAR_GAP = 1;
const BAR_RADIUS = 2;
// Fallback fill if the --tl-waveform CSS variable can't be read.
const DEFAULT_WAVE_COLOR = "#374151";

// ── Pure reduction helpers ────────────────────────────────────────────────────
// Lifted out of the painter so the fiddly bin→column math (where off-by-ones and
// scale bugs hide) is unit-testable without a canvas. The painter calls these.

/** Largest peak in the envelope — the global normalization reference. */
export function computePeakMax(peaks: Float32Array | number[]): number {
  let max = 0;
  for (let i = 0; i < peaks.length; i++) if (peaks[i] > max) max = peaks[i];
  return max;
}

/** Bins whose content-pixel columns intersect the viewport
 *  [scrollLeftPx, scrollLeftPx + viewWidthPx], padded one column each side so the
 *  filled envelope reaches both edges, clamped to [0, binCount - 1]. Device px. */
export function continuousBinRange(
  scrollLeftPx: number,
  viewWidthPx: number,
  pxPerSec: number,
  binsPerSec: number,
  binCount: number,
): { firstBin: number; lastBin: number } {
  const firstBin = Math.max(0, Math.floor((scrollLeftPx / pxPerSec) * binsPerSec) - 1);
  const lastBin = Math.min(binCount - 1, Math.ceil(((scrollLeftPx + viewWidthPx) / pxPerSec) * binsPerSec) + 1);
  return { firstBin, lastBin };
}

/** Max-reduce peak bins [firstBin, lastBin] into integer content-pixel columns:
 *  one envelope point per column, its amplitude the per-column max × ampScale
 *  floored at minAmp (so silence still reads as a thin centerline).
 *  col = floor((bin / binsPerSec) × pxPerSec). Writes into outX/outAmp (cleared
 *  first; passed in so the painter reuses buffers and avoids per-frame allocation). */
export function reduceColumns(
  peaks: Float32Array | number[],
  firstBin: number,
  lastBin: number,
  binsPerSec: number,
  pxPerSec: number,
  ampScale: number,
  minAmp: number,
  outX: number[],
  outAmp: number[],
): void {
  outX.length = 0;
  outAmp.length = 0;
  let curCol = -1;
  let curMax = 0;
  for (let b = firstBin; b <= lastBin; b++) {
    const col = Math.floor((b / binsPerSec) * pxPerSec);
    if (col !== curCol) {
      if (curCol >= 0) { outX.push(curCol); outAmp.push(Math.max(curMax * ampScale, minAmp)); }
      curCol = col;
      curMax = 0;
    }
    if (peaks[b] > curMax) curMax = peaks[b];
  }
  if (curCol >= 0) { outX.push(curCol); outAmp.push(Math.max(curMax * ampScale, minAmp)); }
}

export interface WaveformPainter {
  /** Peak envelope from the pipeline. audioDuration is the seconds the peaks
   *  cover (sidecar-reported). */
  setPeaks(peaks: Float32Array, audioDuration: number): void;
  /** Seconds of the timeline layout axis (the video clock). Audio that ends
   *  before the video does just leaves the tail of the row empty — only bins
   *  that exist are drawn. */
  setLayoutDuration(seconds: number): void;
  /** Switch between the bars and continuous-envelope renderings. */
  setStyle(style: WaveformStyle): void;
  /** Set the fill color (sourced from the --tl-waveform CSS variable). */
  setColor(color: string): void;
  schedulePaint(): void;
  destroy(): void;
}

export function createWaveformPainter(opts: {
  canvas: HTMLCanvasElement;
  /** Outer scroll container — provides scrollLeft, viewport and content width. */
  scrollEl: HTMLElement;
  /** Full-width waveform row — provides the row height. */
  rowEl: HTMLElement;
}): WaveformPainter {
  const { canvas, scrollEl, rowEl } = opts;
  const ctx = canvas.getContext("2d");

  let peaks: Float32Array | null = null;
  let audioDuration = 0;
  let layoutDuration = 0;
  let peakMax = 0;
  let raf = 0;
  let style: WaveformStyle = "continuous";
  let color = DEFAULT_WAVE_COLOR;
  // Reused across paints (this runs on the per-scroll-frame hot path) to avoid
  // per-frame allocation: the envelope's content-x and half-amplitude per column.
  const pxBuf: number[] = [];
  const ampBuf: number[] = [];

  const paint = () => {
    if (!ctx) return;
    const viewWidth = scrollEl.clientWidth;
    const rowHeight = rowEl.clientHeight;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.round(viewWidth * dpr);
    const h = Math.round(rowHeight * dpr);
    if (w <= 0 || h <= 0) return;

    // Resizing the backing store implicitly clears it.
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${viewWidth}px`;
      canvas.style.height = `${rowHeight}px`;
    } else {
      ctx.clearRect(0, 0, w, h);
    }

    if (!peaks || !peaks.length || peakMax <= 0 || audioDuration <= 0 || layoutDuration <= 0) return;

    // Geometry shared by both styles (all in device px). Normalize amplitude
    // against the global max so it reads the same at every zoom level.
    const totalWidth = scrollEl.scrollWidth * dpr;
    const scrollLeft = scrollEl.scrollLeft * dpr;
    const pxPerSec = totalWidth / layoutDuration;
    const binsPerSec = peaks.length / audioDuration;
    const halfHeight = h / 2;
    const ampScale = halfHeight / peakMax;
    ctx.fillStyle = color;

    if (style === "bars") {
      // One rounded bar per grid column, max-reduced over the bins in it. The
      // grid is anchored to the content (not the viewport) so bars stay put
      // while panning. Zoomed past the data density (under one bin per column)
      // this leaves empty columns rather than inventing detail.
      const spacing = (BAR_WIDTH + BAR_GAP) * dpr;
      const barWidth = BAR_WIDTH * dpr;
      const radius = BAR_RADIUS * dpr;
      const firstBin = Math.max(0, Math.floor(((scrollLeft - spacing) / pxPerSec) * binsPerSec));
      const lastBin = Math.min(peaks.length - 1, Math.ceil(((scrollLeft + w) / pxPerSec) * binsPerSec));
      ctx.beginPath();
      let column = -1;
      let columnMax = 0;
      const flush = () => {
        if (column < 0) return;
        const top = Math.round(columnMax * ampScale);
        ctx.roundRect(column * spacing - scrollLeft, halfHeight - top, barWidth, top * 2 || 1, radius);
      };
      for (let b = firstBin; b <= lastBin; b++) {
        const col = Math.floor(((b / binsPerSec) * pxPerSec) / spacing);
        if (col !== column) { flush(); column = col; columnMax = 0; }
        if (peaks[b] > columnMax) columnMax = peaks[b];
      }
      flush();
      ctx.fill();
      return;
    }

    // Continuous: max-reduce bins into integer content-pixel columns — one
    // envelope point per column. Bins are in position order, so columns come out
    // ordered and a point is emitted each time the column advances. The points
    // are connected into one filled shape mirrored about the centerline — a
    // continuous waveform. Zoomed past the data density the points spread out and
    // the fill interpolates between them (a smooth envelope) rather than leaving
    // gaps. Floor each column so silence still reads as a thin centerline.
    const minAmp = 0.5 * dpr;
    const { firstBin, lastBin } = continuousBinRange(scrollLeft, w, pxPerSec, binsPerSec, peaks.length);
    reduceColumns(peaks, firstBin, lastBin, binsPerSec, pxPerSec, ampScale, minAmp, pxBuf, ampBuf);
    if (!pxBuf.length) return;
    ctx.beginPath();
    ctx.moveTo(pxBuf[0] - scrollLeft, halfHeight - ampBuf[0]);
    for (let i = 1; i < pxBuf.length; i++) ctx.lineTo(pxBuf[i] - scrollLeft, halfHeight - ampBuf[i]);
    for (let i = pxBuf.length - 1; i >= 0; i--) ctx.lineTo(pxBuf[i] - scrollLeft, halfHeight + ampBuf[i]);
    ctx.closePath();
    ctx.fill();
  };

  const schedulePaint = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      paint();
    });
  };

  // Scroll events fire before the rAF phase, so a scheduled paint lands in
  // the same frame as the scroll. ResizeObserver fires after layout, past
  // this frame's rAF phase — paint synchronously there to avoid the
  // one-frame lag on zoom/resize.
  scrollEl.addEventListener("scroll", schedulePaint, { passive: true });
  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => paint())
    : null;
  resizeObserver?.observe(rowEl);

  return {
    setPeaks(p, dur) {
      peaks = p;
      audioDuration = dur;
      peakMax = computePeakMax(p);
      schedulePaint();
    },
    setLayoutDuration(seconds) {
      if (seconds === layoutDuration) return;
      layoutDuration = seconds;
      schedulePaint();
    },
    setStyle(s) {
      if (s === style) return;
      style = s;
      schedulePaint();
    },
    setColor(c) {
      if (!c || c === color) return;
      color = c;
      schedulePaint();
    },
    schedulePaint,
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      resizeObserver?.disconnect();
      scrollEl.removeEventListener("scroll", schedulePaint);
    },
  };
}
