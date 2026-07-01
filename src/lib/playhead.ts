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
 *  past the next caption's start (or the clip duration). Callers snapping the
 *  result must use snapToMediaFrame so the round can't cross the media end. */
export function clampEnd(time: number, ownStart: number, nextStart: number | null, dur: number, minDur: number): number {
  return Math.max(ownStart + minDur, Math.min(time, nextStart ?? dur));
}

/**
 * Round a time to the nearest frame boundary that actually EXISTS in the media:
 * the regular frame grid truncated at the media end, with `dur` itself as the
 * final boundary. When the media ends mid-frame (audio, or a duration reported a
 * hair short of the frame boundary) the tail cell is partial — to the user the end
 * of the timeline IS the next boundary, so rounding inside that cell flips at its
 * visible midpoint (between the last whole frame and the media end), never at the
 * midpoint of a phantom frame that extends past the end. On a frame-perfect
 * duration this is exactly snapToFrame.
 */
export function snapToMediaFrame(time: number, fps: number, dur: number): number {
  // Last whole-frame boundary ≤ dur (epsilon absorbs float error so a frame-
  // aligned dur stays on its own boundary).
  const lastWhole = Math.floor(dur * fps + FRAME_EPS) / fps;
  if (time > lastWhole) {
    // Inside the partial tail cell: its real flanking boundaries are the last
    // whole frame and the media end — round to the nearer of the two.
    return dur - time <= time - lastWhole ? dur : lastWhole;
  }
  return snapToFrame(time, fps);
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
  const end = snapToMediaFrame(clampEnd(time, cap.start, nextStart, dur, minDur), fps, dur);
  return end === cap.end ? null : { start: cap.start, end };
}

export interface RollResult {
  left: { index: number; start: number; end: number };
  right: { index: number; start: number; end: number };
}

/**
 * Compute a rolling edit: move the shared cut on the selected caption's `side`
 * (the boundary it shares with its previous/next neighbour) to `time`, dragging
 * both flanking edges with it — left.end and right.start both become the cut. The
 * cut is clamped within the two captions (each keeps ≥ one frame) and snapped to a
 * frame. Returns null if there's no neighbour on that side, the boundary isn't
 * shared (a gap — nothing to roll), the caption isn't found, or it'd be a no-op.
 * `captions` are assumed sorted by start, so array neighbours are temporal ones.
 */
export function computeRoll(
  captions: readonly { index: number; start: number; end: number }[],
  index: number,
  side: "in" | "out",
  time: number,
  fps: number,
  eps = 1e-4,
): RollResult | null {
  const pos = captions.findIndex((c) => c.index === index);
  if (pos < 0) return null;
  // The two captions flanking the cut: left | right.
  const left = captions[side === "in" ? pos - 1 : pos];
  const right = captions[side === "in" ? pos : pos + 1];
  if (!left || !right) return null; // no neighbour on that side
  if (Math.abs(left.end - right.start) > eps) return null; // not a shared boundary
  const minDur = 1 / fps;
  const cut = snapToFrame(Math.max(left.start + minDur, Math.min(time, right.end - minDur)), fps);
  if (cut === left.end) return null; // cut wouldn't move
  return {
    left: { index: left.index, start: left.start, end: cut },
    right: { index: right.index, start: cut, end: right.end },
  };
}

export interface AddCaptionResult { start: number; end: number; insertPos: number; }

/**
 * Where/how the Add-caption action would insert a caption at `playhead`. Snaps the
 * start to the nearest existing boundary (snapToMediaFrame — a start that rounds to
 * the media end means "nothing left to caption" → null, and the flip point in a
 * partial tail cell is its visible midpoint); the end is start + 2s, capped at the
 * next caption's start or the media end. Returns null when it would be a no-op: the
 * playhead sits inside an existing caption, or it's at the media end. `captions`
 * are assumed sorted by start. Shared by addCaption and the header button's
 * enabled state so the two can't disagree.
 */
export function computeAddCaption(
  captions: readonly { start: number; end: number }[],
  playhead: number,
  fps: number,
  dur: number,
): AddCaptionResult | null {
  const start = snapToMediaFrame(playhead, fps, dur);
  if (captions.some((c) => start >= c.start && start < c.end)) return null;
  const nextStart = captions.find((c) => c.start > start)?.start;
  const maxEnd = nextStart ?? dur;
  const end = snapToMediaFrame(Math.min(start + 2, maxEnd), fps, dur);
  if (end <= start) return null;
  const insertPos = captions.filter((c) => c.end <= start).length;
  return { start, end, insertPos };
}
