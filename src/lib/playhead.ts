/**
 * Pure playhead / frame arithmetic for timeline navigation. Extracted from the
 * Timeline and VideoPanel components so the boundary math — which is fiddly and
 * has had off-by-one bugs — can be unit-tested in isolation.
 */
import { snapToFrame } from "./pipeline";

// Absorbs floating-point error in `time * fps` for frame-aligned times (e.g. a
// playhead parked at frame N via N/fps, whose round-trip lands at N ± ~1e-12).
const FRAME_EPS = 1e-6;

/**
 * Time of the adjacent frame BOUNDARY from `time` in direction `dir`
 * (1 = forward, -1 = back). Always moves to the next/previous frame boundary,
 * regardless of where within the current frame the playhead sits — NOT "round to
 * the nearest frame, then ±1", which skips a frame when the playhead is in the
 * far half between two frames. A playhead already on a frame advances by exactly
 * one. Not clamped to the clip — the caller does that.
 */
export function frameStep(time: number, fps: number, dir: 1 | -1): number {
  const frame = dir > 0
    ? Math.floor(time * fps + FRAME_EPS) + 1
    : Math.ceil(time * fps - FRAME_EPS) - 1;
  return frame / fps;
}

/**
 * Time to seek a <video> element to so it reliably displays the frame containing
 * `time`: the middle of that frame. Seeking to a frame boundary (N/fps) is
 * ambiguous — it sits on the seam between frames N-1 and N, so the decoder may
 * resolve to either, making frame-stepping land a frame early/late at random.
 */
export function frameMidpoint(time: number, fps: number): number {
  return (Math.floor(time * fps + FRAME_EPS) + 0.5) / fps;
}

/**
 * Nearest value in `bounds` strictly past `time` in direction `dir` (1 = next,
 * -1 = previous), or undefined if there is none. `bounds` need not be sorted.
 * `eps` makes a boundary the playhead is essentially sitting on get skipped, so
 * repeated presses advance instead of sticking.
 */
export function nextBoundary(
  time: number,
  bounds: number[],
  dir: 1 | -1,
  eps = 1e-4,
): number | undefined {
  const sorted = [...bounds].sort((a, b) => a - b);
  if (dir > 0) return sorted.find((b) => b > time + eps);
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i] < time - eps) return sorted[i];
  }
  return undefined;
}

// ── Caption edge clamps (shared by the resize-handle drag and [ / ] trim) ─────
// Both clamp a proposed edge time to its valid range so it can't overlap the
// neighbouring caption or collapse the caption below `minDur`. `prevEnd`/`nextStart`
// are the adjacent captions' edges (null at the clip ends → 0 / clip duration).
// Callers snap the result to a frame.

/** Clamp a caption's start edge: not before the previous caption's end, and at
 *  least `minDur` before its own end. */
export function clampStart(time: number, prevEnd: number | null, ownEnd: number, minDur: number): number {
  return Math.max(prevEnd ?? 0, Math.min(time, ownEnd - minDur));
}

/** Clamp a caption's end edge: at least `minDur` after its own start, and not
 *  past the next caption's start (or the clip duration). */
export function clampEnd(time: number, ownStart: number, nextStart: number | null, dur: number, minDur: number): number {
  return Math.max(ownStart + minDur, Math.min(time, nextStart ?? dur));
}

export interface TrimResult { start: number; end: number; }

/**
 * New timing for trimming the caption at `index`'s in/out edge to `time` (the
 * playhead). Picks the neighbouring caption's edge as the bound, clamps so it
 * can't overlap the neighbour or collapse below one frame, and snaps to a frame.
 * Returns null when the caption isn't found or the edge wouldn't move — a no-op
 * the caller should skip rather than commit to undo history. `captions` are
 * assumed sorted by start (the editor's invariant), so the array neighbours are
 * the temporal ones.
 */
export function computeTrim(
  captions: readonly { index: number; start: number; end: number }[],
  index: number,
  edge: "in" | "out",
  time: number,
  fps: number,
  dur: number,
): TrimResult | null {
  const pos = captions.findIndex((c) => c.index === index);
  if (pos < 0) return null;
  const cap = captions[pos];
  const minDur = 1 / fps;
  if (edge === "in") {
    const prevEnd = pos > 0 ? captions[pos - 1].end : null;
    const start = snapToFrame(clampStart(time, prevEnd, cap.end, minDur), fps);
    return start === cap.start ? null : { start, end: cap.end };
  }
  const nextStart = pos < captions.length - 1 ? captions[pos + 1].start : null;
  const end = snapToFrame(clampEnd(time, cap.start, nextStart, dur, minDur), fps);
  return end === cap.end ? null : { start: cap.start, end };
}
