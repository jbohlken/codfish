import { describe, it, expect } from "vitest";
import { codometer, approach, buildReaderSchedule, readerPosition } from "../codometer";

const MAX_CPS = 17;

function block(chars: number, duration: number) {
  return { start: 0, end: duration, lines: ["x".repeat(chars)] };
}

describe("codometer", () => {
  it("cruises in a gap (no caption under the playhead)", () => {
    expect(codometer(null, MAX_CPS)).toEqual({ mode: "cruise", period: 3, cps: 0 });
  });
  it("reports the cps that produced the state", () => {
    expect(codometer(block(30, 2), MAX_CPS).cps).toBeCloseTo(15, 9);
    expect(codometer(block(40, 2), MAX_CPS).cps).toBeCloseTo(20, 9); // belly-up still reports
  });
  it("cruises on an empty caption", () => {
    expect(codometer({ start: 0, end: 2, lines: [""] }, MAX_CPS).mode).toBe("cruise");
  });
  it("cruises (rather than dividing by zero) on a zero-duration caption", () => {
    expect(codometer({ start: 1, end: 1, lines: ["hi"] }, MAX_CPS).mode).toBe("cruise");
  });
  it("swims faster as CPS approaches the limit", () => {
    const slow = codometer(block(10, 2), MAX_CPS); // 5 cps
    const fast = codometer(block(30, 2), MAX_CPS); // 15 cps
    expect(slow.mode).toBe("swim");
    expect(fast.mode).toBe("swim");
    expect(fast.period).toBeLessThan(slow.period);
  });
  it("hits full panic (minimum period) at exactly maxCps", () => {
    const s = codometer(block(34, 2), 17); // exactly 17 cps
    expect(s.mode).toBe("swim");
    expect(s.period).toBeCloseTo(0.45, 9);
  });
  it("goes belly-up past maxCps — same threshold as the reading-speed warning", () => {
    const s = codometer(block(40, 2), MAX_CPS); // 20 cps > 17
    expect(s.mode).toBe("bellyup");
  });
  it("counts characters across lines like validate.ts (sum of line lengths)", () => {
    // 3 lines × 20 chars in 2s = 30 cps > 17 → belly-up.
    const s = codometer({ start: 0, end: 2, lines: ["x".repeat(20), "y".repeat(20), "z".repeat(20)] }, MAX_CPS);
    expect(s.mode).toBe("bellyup");
  });
});

describe("approach (swim smoothing)", () => {
  it("moves toward the target without overshooting", () => {
    const next = approach(3, 0.5, 0.016, 0.3);
    expect(next).toBeLessThan(3);
    expect(next).toBeGreaterThan(0.5);
  });
  it("is frame-rate independent: two half-steps equal one full step", () => {
    const one = approach(3, 0.5, 0.032, 0.3);
    const two = approach(approach(3, 0.5, 0.016, 0.3), 0.5, 0.016, 0.3);
    expect(two).toBeCloseTo(one, 9);
  });
  it("converges to the target", () => {
    let v = 3;
    for (let i = 0; i < 600; i++) v = approach(v, 0.5, 0.016, 0.3);
    expect(v).toBeCloseTo(0.5, 3);
  });
  it("zero dt is a no-op; zero tau snaps", () => {
    expect(approach(3, 0.5, 0, 0.3)).toBe(3);
    expect(approach(3, 0.5, 0.016, 0)).toBe(0.5);
  });
});

describe("virtual reader (buildReaderSchedule + readerPosition)", () => {
  const cap = (start: number, end: number, chars: number) => ({ start, end, lines: ["x".repeat(chars)] });

  it("at exactly target speed the reader rides the playhead", () => {
    // 20 chars over 2s at maxCps 10 → reads for exactly the display span.
    const sched = buildReaderSchedule([cap(0, 2, 20)], 10);
    expect(readerPosition(sched, 1)).toBeCloseTo(1, 9);
    expect(readerPosition(sched, 2)).toBeCloseTo(2, 9);
  });
  it("falls behind on a hot caption and keeps reading it after its span ends", () => {
    // 60 chars over [0,2] at maxCps 15 → needs 4s of reading.
    const sched = buildReaderSchedule([cap(0, 2, 60)], 15);
    expect(readerPosition(sched, 2)).toBeCloseTo(1, 9);   // half read → mid-span
    expect(readerPosition(sched, 3)).toBeCloseTo(1.5, 9); // still back in the span
    expect(readerPosition(sched, 4)).toBeCloseTo(4, 9);   // done → rides playhead
  });
  it("pulls ahead on a light caption, capped at the caption's end", () => {
    // 20 chars over [0,4] at maxCps 10 → done at t=2.
    const sched = buildReaderSchedule([cap(0, 4, 20)], 10);
    expect(readerPosition(sched, 1)).toBeCloseTo(2, 9); // read half → span midpoint... ahead of playhead
    expect(readerPosition(sched, 3)).toBeCloseTo(4, 9); // finished → parked at the caption's end
    expect(readerPosition(sched, 5)).toBeCloseTo(5, 9); // playhead passed it → rides along
  });
  it("chains backlog into the next caption (debt carries forward)", () => {
    // A: 60 chars [0,2] needs 4s; B: 20 chars [2,4] can't start until A is done.
    const sched = buildReaderSchedule([cap(0, 2, 60), cap(2, 4, 20)], 15);
    expect(sched[1].readStart).toBeCloseTo(4, 9);
    // At t=4.5: 7.5 of B's 20 chars read → 37.5% into B's span [2,4].
    expect(readerPosition(sched, 4.5)).toBeCloseTo(2 + 0.375 * 2, 9);
  });
  it("banks no credit through gaps", () => {
    // A finishes early at t=1; long gap; B starts at 10.
    const sched = buildReaderSchedule([cap(0, 2, 10), cap(10, 12, 10)], 10);
    expect(readerPosition(sched, 5)).toBeCloseTo(5, 9);   // gap → on the playhead
    expect(sched[1].readStart).toBeCloseTo(10, 9);        // B waits for its display
  });
  it("skips empty captions and handles an empty schedule", () => {
    const sched = buildReaderSchedule([{ start: 0, end: 2, lines: [""] }], 10);
    expect(sched).toEqual([]);
    expect(readerPosition(sched, 1)).toBe(1);
  });
});
