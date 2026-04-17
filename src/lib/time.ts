/**
 * Shared time utilities — single source of truth for all time operations.
 *
 * Every time comparison, frame snap, unit conversion, and display format
 * in Codfish flows through this module.
 */

import type { TimedRule } from "../types/profile";

// ── Constants ──────────────────────────────────────────────────────────────

/** 1 microsecond — well below any frame boundary (1 frame at 60fps ≈ 16,667 µs). */
export const EPSILON = 1e-6;

// ── Epsilon-tolerant comparisons ───────────────────────────────────────────

/** a ≈ b (within 1 µs). */
export function timeEq(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
}

/** a genuinely less than b (not just floating-point noise). */
export function timeLt(a: number, b: number): boolean {
  return a < b - EPSILON;
}

/** a genuinely greater than b. */
export function timeGt(a: number, b: number): boolean {
  return a > b + EPSILON;
}

/** a less than or approximately equal to b. */
export function timeLte(a: number, b: number): boolean {
  return a < b + EPSILON;
}

/** a greater than or approximately equal to b. */
export function timeGte(a: number, b: number): boolean {
  return a > b - EPSILON;
}

// ── Frame operations ───────────────────────────────────────────────────────

/** Snap a time value to the nearest frame boundary. */
export function snapToFrame(timeSeconds: number, fps: number): number {
  const frame = Math.round(timeSeconds * fps);
  return frame / fps;
}

/** Count the number of frames between two times. */
export function framesBetween(start: number, end: number, fps: number): number {
  return Math.round((end - start) * fps);
}

/**
 * Truncate a time value to its integer frame index, absorbing sub-ULP float drift.
 *
 * Accumulated tick times like 6/24 can land at 0.24999999999999997, so a naive
 * `Math.floor(t * fps)` eats a frame and produces a duplicate-then-skip sequence
 * (e.g. "0 1 2 3 4 5 5 6 8 9 10f" on a 24fps ruler, or "01:01, 01:01, 01:03" in
 * SMPTE labels). Adding 1e-6 in frame-count space — far below any real frame
 * boundary (1e-6 frame at 1000fps is 1 ns) — keeps boundary-aligned frames on
 * the correct side of floor without shifting mid-frame times across a boundary.
 */
export function toFrameIndex(t: number, fps: number): number {
  return Math.floor(t * fps + 1e-6);
}

// ── Unit conversion ────────────────────────────────────────────────────────

/** Convert a timed rule (seconds or frames) to seconds. */
export function toSeconds(rule: TimedRule, fps: number): number {
  return rule.unit === "fr" ? rule.value / fps : rule.value;
}

// ── Precision-safe component extraction ────────────────────────────────────

/** Extract hours, minutes, whole seconds, and fractional part with precision guard.
 *  Snap t to nanosecond precision once, then derive every component from the same
 *  snapped value so they stay mutually consistent. Without this, float-accumulation
 *  drift can leave a value meant to be 1.0 arriving as 0.9999999999998, which the
 *  old split-floor-and-round path mapped to `{s: 0, frac: 1.0}` — internally
 *  contradictory and causing "00:00:00.1000" / "00:00:00:24" displays. Nanoseconds
 *  are far below any frame boundary we'll ever display (1 frame at 1000fps = 1M ns). */
export function timeComponents(t: number): { h: number; m: number; s: number; frac: number } {
  const nanos = Math.round(t * 1e9);
  const integerSeconds = Math.floor(nanos / 1e9);
  const fracNanos = nanos - integerSeconds * 1e9;
  const h = Math.floor(integerSeconds / 3600);
  const m = Math.floor((integerSeconds % 3600) / 60);
  const s = integerSeconds % 60;
  const frac = fracNanos / 1e9;
  return { h, m, s, frac };
}

// ── SMPTE timecode ─────────────────────────────────────────────────────────

/** Whether a frame rate supports drop-frame counting (29.97 or 59.94). */
export function isDropFrameRate(fps: number): boolean {
  return Math.abs(fps - 29.97) < 0.02 || Math.abs(fps - 59.94) < 0.02;
}

/**
 * Format a time value as SMPTE timecode (HH:mm:ss:ff or HH:mm:ss;ff).
 *
 * Drop-frame (;) skips frame numbers 0–1 (for 29.97) or 0–3 (for 59.94)
 * at the start of each minute, except every 10th minute. This keeps the
 * timecode aligned with wall-clock time.
 *
 * If drop-frame is requested but fps is incompatible, falls back to NDF.
 */
export function formatSmpte(t: number, fps: number, dropFrame: boolean): string {
  const roundFps = Math.round(fps);

  // Fall back to NDF if fps doesn't support drop-frame
  if (dropFrame && !isDropFrameRate(fps)) {
    dropFrame = false;
  }

  const totalFrames = toFrameIndex(t, fps);

  let h: number, m: number, s: number, f: number;

  if (dropFrame) {
    const dropCount = roundFps <= 30 ? 2 : 4;
    const framesPerMin = roundFps * 60 - dropCount;         // 1798 for 29.97
    const framesPer10Min = framesPerMin * 10 + dropCount;   // 17982 for 29.97

    const blocks10 = Math.floor(totalFrames / framesPer10Min);
    let remainder = totalFrames % framesPer10Min;

    let minuteInBlock: number;
    let frameInMinute: number;

    // First minute of each 10-min block has no drops (full roundFps*60 frames)
    const firstMinFrames = roundFps * 60; // 1800 for 29.97
    if (remainder < firstMinFrames) {
      minuteInBlock = 0;
      frameInMinute = remainder;
    } else {
      remainder -= firstMinFrames;
      minuteInBlock = 1 + Math.floor(remainder / framesPerMin);
      frameInMinute = dropCount + (remainder % framesPerMin);
    }

    const totalMinutes = blocks10 * 10 + minuteInBlock;
    h = Math.floor(totalMinutes / 60);
    m = totalMinutes % 60;
    s = Math.floor(frameInMinute / roundFps);
    f = frameInMinute % roundFps;
  } else {
    const { h: ch, m: cm, s: cs, frac } = timeComponents(t);
    h = ch;
    m = cm;
    s = cs;
    f = toFrameIndex(frac, fps);
  }

  const sep = dropFrame ? ";" : ":";
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(f).padStart(2, "0")}`;
}

// ── Display formatting ─────────────────────────────────────────────────────

export type DisplayMode = "time" | "smpte" | "smpte-df" | "frames";

/**
 * Format a time value for UI display.
 *
 *   - "time":     HH:MM:SS.mmm (or MM:SS.mmm when compact && hours === 0)
 *   - "smpte":    HH:MM:SS:FF  (non-drop-frame)
 *   - "smpte-df": HH:MM:SS;FF  (drop-frame, falls back to NDF if fps incompatible)
 *   - "frames":   Nf
 *
 * compact omits leading hours when they're 0 (used by CaptionPanel).
 */
export function formatDisplayTime(seconds: number, mode: DisplayMode, fps: number, compact = false): string {
  switch (mode) {
    case "time": {
      const { h, m, s, frac } = timeComponents(seconds);
      const ms = Math.floor(frac * 1000);
      if (compact && h === 0) {
        return `${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
      }
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
    }
    case "smpte":
      return formatSmpte(seconds, fps, false);
    case "smpte-df":
      return formatSmpte(seconds, fps, true);
    case "frames":
      return `${toFrameIndex(seconds, fps)}f`;
  }
}
