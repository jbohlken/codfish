/**
 * Cod-o-meter — the codfish that swims alongside the playhead at the current
 * caption's reading speed. Pure math here (unit-tested); the Timeline renders it.
 *
 * CPS and the belly-up threshold intentionally mirror validate.ts's reading-speed
 * rule (sum of line lengths / duration, warn when cps > maxCps), so the fish and
 * the warnings can never disagree about what "too fast" means.
 */

export type CodometerMode = "cruise" | "swim" | "bellyup";

export interface CodometerState {
  mode: CodometerMode;
  /** TARGET seconds per swim cycle — the renderer eases toward it (see approach)
   *  and advances a phase accumulator, so speed changes ramp smoothly instead of
   *  snapping the fish to a different point in its bob. */
  period: number;
  /** The chars-per-second that produced this state (0 when cruising with no
   *  readable caption) — surfaced for the debug readout next to the fish. */
  cps: number;
}

/** Frame-rate-independent exponential smoothing: move `current` toward `target`
 *  over `dt` seconds with time constant `tau` (≈63% of the way per tau). Two
 *  half-steps land exactly where one full step does, so the ramp looks the same
 *  at any frame rate. */
export function approach(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0 || dt <= 0) return tau <= 0 ? target : current;
  return target + (current - target) * Math.exp(-dt / tau);
}

/** Relaxed cycle when idling in a gap (or well under the reading limit). */
const CRUISE_PERIOD = 3;
/** Full panic at exactly maxCps. */
const MIN_PERIOD = 0.45;
/** Gentle float once it's gone belly-up. */
const BELLYUP_PERIOD = 2.4;

// ── Virtual reader (the debt gauge) ─────────────────────────────────────────
// The fish's POSITION is a cumulative reading balance: simulate a reader who
// reads at exactly maxCps from media start, consuming each caption's characters
// in order from the moment it's displayed. Reading exactly at target keeps the
// reader on the playhead; hot captions leave them stuck back in earlier text
// (fish falls behind, hovering over the words still being read); light captions
// let them finish early and wait at the caption's end (fish pulls ahead, capped
// there — text that isn't displayed yet can't be read, and gaps bank no credit).

export interface ReaderSlot {
  /** Caption display span. */
  start: number;
  end: number;
  /** When the virtual reader starts/finishes reading this caption's text. */
  readStart: number;
  readEnd: number;
}

/** Build the reader's schedule for a caption list (assumed sorted by start).
 *  Empty captions cost nothing and are skipped. O(n), rebuild on caption edits. */
export function buildReaderSchedule(
  captions: readonly { start: number; end: number; lines: string[] }[],
  maxCps: number,
): ReaderSlot[] {
  if (maxCps <= 0) return [];
  const slots: ReaderSlot[] = [];
  let freeAt = 0;
  for (const c of captions) {
    const chars = c.lines.reduce((sum, l) => sum + l.length, 0);
    if (chars <= 0) continue;
    const readStart = Math.max(c.start, freeAt);
    const readEnd = readStart + chars / maxCps;
    slots.push({ start: c.start, end: c.end, readStart, readEnd });
    freeAt = readEnd;
  }
  return slots;
}

/** The virtual reader's position in the media at time `t`: prorated into the
 *  span of the caption they're currently reading, parked at the end of the last
 *  finished caption while its span is still current, else riding the playhead. */
export function readerPosition(schedule: readonly ReaderSlot[], t: number): number {
  // Binary search: first slot with readEnd > t (the caption being read, or the
  // next one if the reader is idle).
  let lo = 0, hi = schedule.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (schedule[mid].readEnd > t) hi = mid;
    else lo = mid + 1;
  }
  const slot = schedule[lo];
  if (slot && slot.readStart <= t) {
    // Mid-read: how far through the text, mapped into the caption's span.
    const frac = (t - slot.readStart) / (slot.readEnd - slot.readStart);
    return slot.start + frac * (slot.end - slot.start);
  }
  // Idle: everything displayed so far is read. Wait at the end of the last
  // finished caption while the playhead is still inside it (ahead); once the
  // playhead passes it, ride the playhead.
  const prev = schedule[lo - 1];
  return prev ? Math.max(t, prev.end) : t;
}

export function codometer(
  block: { start: number; end: number; lines: string[] } | null,
  maxCps: number,
): CodometerState {
  if (!block || maxCps <= 0) return { mode: "cruise", period: CRUISE_PERIOD, cps: 0 };
  const duration = block.end - block.start;
  if (duration <= 0) return { mode: "cruise", period: CRUISE_PERIOD, cps: 0 };
  const totalChars = block.lines.reduce((sum, l) => sum + l.length, 0);
  const cps = totalChars / duration;
  if (cps <= 0) return { mode: "cruise", period: CRUISE_PERIOD, cps: 0 };
  if (cps > maxCps) return { mode: "bellyup", period: BELLYUP_PERIOD, cps };
  // Swim faster as the reading speed approaches the limit: full cruise at 0,
  // full panic at exactly maxCps.
  const ratio = cps / maxCps;
  const period = CRUISE_PERIOD - (CRUISE_PERIOD - MIN_PERIOD) * ratio;
  return { mode: "swim", period, cps };
}
