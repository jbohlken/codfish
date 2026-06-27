import { describe, it, expect } from "vitest";
import { computePeakMax, continuousBinRange, reduceColumns } from "../waveform";

describe("computePeakMax", () => {
  it("returns the largest peak", () => {
    expect(computePeakMax(new Float32Array([0.1, 0.5, 0.3]))).toBe(0.5);
  });
  it("is 0 for empty or all-zero input", () => {
    expect(computePeakMax(new Float32Array([]))).toBe(0);
    expect(computePeakMax(new Float32Array([0, 0, 0]))).toBe(0);
  });
});

describe("continuousBinRange", () => {
  // pxPerSec=100, binsPerSec=10 → one bin per 10 content px; binCount=1000.
  const P = 100, B = 10, N = 1000;
  it("clamps the start to 0 (with the leading -1 pad)", () => {
    expect(continuousBinRange(0, 200, P, B, N)).toEqual({ firstBin: 0, lastBin: 21 });
  });
  it("windows to the visible span, padded one column each side", () => {
    expect(continuousBinRange(500, 200, P, B, N)).toEqual({ firstBin: 49, lastBin: 71 });
  });
  it("clamps the end to the last bin", () => {
    expect(continuousBinRange(9900, 200, P, B, N)).toEqual({ firstBin: 989, lastBin: 999 });
  });
});

describe("reduceColumns", () => {
  // Exact binary-fraction peaks + ampScale so the float math is exact for toEqual.
  const x: number[] = [];
  const a: number[] = [];

  it("emits one max-reduced point per content column", () => {
    // binsPerSec=1, pxPerSec=1 → col = bin; ampScale=4, minAmp=0.1.
    reduceColumns([0.5, 0.25, 0.75], 0, 2, 1, 1, 4, 0.1, x, a);
    expect(x).toEqual([0, 1, 2]);
    expect(a).toEqual([2, 1, 3]); // 0.5×4, 0.25×4, 0.75×4
  });

  it("max-reduces multiple bins that fall in one column", () => {
    // pxPerSec=0.5 → col = floor(bin/2): bins 0,1 → col 0; bins 2,3 → col 1.
    reduceColumns([0.25, 0.75, 0.5, 0.125], 0, 3, 1, 0.5, 4, 0.1, x, a);
    expect(x).toEqual([0, 1]);
    expect(a).toEqual([3, 2]); // col0 max 0.75→3, col1 max 0.5→2
  });

  it("floors silent/quiet columns at minAmp so they read as a thin line", () => {
    reduceColumns([0, 0.0625], 0, 1, 1, 1, 4, 1, x, a);
    expect(x).toEqual([0, 1]);
    expect(a).toEqual([1, 1]); // 0→floored to 1; 0.0625×4=0.25→floored to 1
  });

  it("clears the output buffers first (they're reused across paints)", () => {
    x.push(999); a.push(999);
    reduceColumns([0.5], 0, 0, 1, 1, 4, 0.1, x, a);
    expect(x).toEqual([0]);
    expect(a).toEqual([2]);
  });

  it("emits nothing for an empty bin range", () => {
    reduceColumns([0.5, 0.6], 1, 0, 1, 1, 4, 0.1, x, a); // firstBin > lastBin
    expect(x).toEqual([]);
    expect(a).toEqual([]);
  });
});
