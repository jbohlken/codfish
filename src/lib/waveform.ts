/**
 * Viewport-sized canvas painter for the timeline waveform.
 *
 * Replaces WaveSurfer's renderer, which rasterized the entire zoomed
 * waveform up front (O(zoom × duration) canvas pixels, all rebuilt on
 * every zoom step). The canvas here is viewport-sized and position:sticky
 * at the left edge of the scroll viewport; each repaint draws only the
 * visible bars, so per-frame cost is O(viewport) regardless of zoom level
 * or media length.
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

// Bar styling matches the previous WaveSurfer config (CSS px).
const BAR_WIDTH = 2;
const BAR_GAP = 1;
const BAR_RADIUS = 2;
const WAVE_COLOR = "#374151";

export interface WaveformPainter {
  /** Peak envelope from the pipeline. audioDuration is the seconds the peaks
   *  cover (sidecar-reported). */
  setPeaks(peaks: Float32Array, audioDuration: number): void;
  /** Seconds of the timeline layout axis (the video clock). Audio that ends
   *  before the video does just leaves the tail of the row empty — only bins
   *  that exist are drawn. */
  setLayoutDuration(seconds: number): void;
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

    // All geometry below is in device px.
    const totalWidth = scrollEl.scrollWidth * dpr;
    const scrollLeft = scrollEl.scrollLeft * dpr;
    const pxPerSec = totalWidth / layoutDuration;
    const binsPerSec = peaks.length / audioDuration;
    const spacing = (BAR_WIDTH + BAR_GAP) * dpr;
    const barWidth = BAR_WIDTH * dpr;
    const radius = BAR_RADIUS * dpr;
    const halfHeight = h / 2;
    // Normalize against the global max so amplitude reads the same at
    // every zoom level (WaveSurfer normalized per 8000px chunk).
    const vScale = 1 / peakMax;

    // Visible bin range, padded one column left so a partially visible
    // edge bar still draws.
    const firstBin = Math.max(0, Math.floor(((scrollLeft - spacing) / pxPerSec) * binsPerSec));
    const lastBin = Math.min(peaks.length - 1, Math.ceil(((scrollLeft + w) / pxPerSec) * binsPerSec));

    // One bar per grid column, max-reduced over the bins that start in it.
    // The grid is anchored to the content (not the viewport) so bars stay
    // put while panning. Zoomed past the data density (under one bin per
    // column) this leaves empty columns rather than inventing detail.
    ctx.fillStyle = WAVE_COLOR;
    ctx.beginPath();
    let column = -1;
    let columnMax = 0;
    const flush = () => {
      if (column < 0) return;
      const top = Math.round(columnMax * halfHeight * vScale);
      ctx.roundRect(column * spacing - scrollLeft, halfHeight - top, barWidth, top * 2 || 1, radius);
    };
    for (let b = firstBin; b <= lastBin; b++) {
      const col = Math.floor(((b / binsPerSec) * pxPerSec) / spacing);
      if (col !== column) {
        flush();
        column = col;
        columnMax = 0;
      }
      if (peaks[b] > columnMax) columnMax = peaks[b];
    }
    flush();
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
      peakMax = 0;
      for (let i = 0; i < p.length; i++) {
        if (p[i] > peakMax) peakMax = p[i];
      }
      schedulePaint();
    },
    setLayoutDuration(seconds) {
      if (seconds === layoutDuration) return;
      layoutDuration = seconds;
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
