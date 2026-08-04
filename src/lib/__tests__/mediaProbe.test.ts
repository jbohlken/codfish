import { describe, it, expect } from "vitest";
import { snapFps, normalizeDuration, looksVfr } from "../mediaProbe";

/** n timestamps at a constant rate, starting at t0. */
const cfr = (n: number, fps: number, t0 = 0) =>
  Array.from({ length: n }, (_, i) => t0 + i / fps);

describe("looksVfr", () => {
  it("flags a mid-file rate change (the 24→60 fixture)", () => {
    expect(looksVfr([...cfr(72, 24), ...cfr(60, 60, 3)])).toBe(true);
  });

  it("passes constant-rate streams, including NTSC fractions", () => {
    expect(looksVfr(cfr(120, 30))).toBe(false);
    expect(looksVfr(cfr(120, 30000 / 1001))).toBe(false);
  });

  it("is immune to B-frame decode order (sorts before measuring)", () => {
    // IPBB-ish arrival order: 0, 3, 1, 2, 7, 5, 6, ... frames of a 30fps stream.
    const pts = cfr(120, 30);
    const decodeOrder: number[] = [];
    for (let i = 0; i < pts.length; i += 4) {
      decodeOrder.push(pts[i], pts[i + 3] ?? NaN, pts[i + 1], pts[i + 2]);
    }
    expect(looksVfr(decodeOrder.filter(Number.isFinite))).toBe(false);
  });

  it("tolerates container timestamp rounding (Matroska ms stamps)", () => {
    // 30 fps stored on a 1 ms grid: deltas alternate 33/34 ms (~3% jitter).
    const stamps = cfr(120, 30).map((t) => Math.round(t * 1000) / 1000);
    expect(looksVfr(stamps)).toBe(false);
  });

  it("tolerates the ms grid at high frame rates (the 2 ms absolute floor)", () => {
    // CFR 59.94 and 120 fps on a 1 ms grid: the ±1 ms alternation exceeds 5%
    // of the median delta but is pure quantization — must NOT read as VFR.
    for (const rate of [59.94, 60, 120]) {
      const stamps = cfr(240, rate).map((t) => Math.round(t * 1000) / 1000);
      expect(looksVfr(stamps), `${rate} fps ms-grid`).toBe(false);
    }
    // …while a genuine 24→60 change still detects despite the floor.
    expect(looksVfr([...cfr(72, 24), ...cfr(60, 60, 3)].map((t) => Math.round(t * 1000) / 1000))).toBe(true);
  });

  it("ignores an isolated dropped frame in a constant stream", () => {
    const stamps = cfr(120, 30).filter((_, i) => i !== 60); // one 2× gap
    expect(looksVfr(stamps)).toBe(false);
  });

  it("ignores duplicate timestamps and refuses tiny samples", () => {
    expect(looksVfr([...cfr(60, 30), ...cfr(60, 30)])).toBe(false); // every stamp twice
    expect(looksVfr(cfr(8, 30))).toBe(false); // below the sample floor
    expect(looksVfr([])).toBe(false);
  });
});

describe("snapFps", () => {
  it("snaps measured NTSC-family rates to canonical values", () => {
    expect(snapFps(29.9700299)).toBe(29.97);
    expect(snapFps(23.9760239)).toBe(23.976);
    expect(snapFps(59.9400599)).toBe(59.94);
    expect(snapFps(30.0001)).toBe(30);
    expect(snapFps(24.02)).toBe(24);
    expect(snapFps(25)).toBe(25);
  });

  it("keeps genuinely unusual rates, rounded to 3 decimals", () => {
    // The VFR fixture's 24→60 fps average — must NOT snap to anything.
    expect(snapFps(31.70344)).toBe(31.703);
    expect(snapFps(15)).toBe(15);
    expect(snapFps(12.5)).toBe(12.5);
  });

  it("distinguishes 48000/1001 from clean 48 (nearest wins)", () => {
    expect(snapFps(48000 / 1001)).toBe(47.952);
    expect(snapFps(48.001)).toBe(48);
  });

  it("rejects unusable rates", () => {
    expect(snapFps(0)).toBeNull();
    expect(snapFps(-1)).toBeNull();
    expect(snapFps(NaN)).toBeNull();
    expect(snapFps(Infinity)).toBeNull();
  });
});

describe("normalizeDuration", () => {
  it("subtracts a positive container start offset (MPEG-TS)", () => {
    // The battery's h264-aac.ts: computeDuration 6.480, firstTimestamp 1.4453.
    expect(normalizeDuration(6.48, 1.4453333)).toBeCloseTo(5.0346667, 6);
  });

  it("ignores a negative start (AAC priming in MP4)", () => {
    // control-h264-aac.mp4: firstTimestamp -0.0213 must not stretch the clip.
    expect(normalizeDuration(5.0, -0.0213333)).toBe(5.0);
  });

  it("passes zero-offset files through and never goes negative", () => {
    expect(normalizeDuration(5.04, 0)).toBe(5.04);
    expect(normalizeDuration(0.5, 2)).toBe(0);
  });
});
