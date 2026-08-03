import { describe, it, expect } from "vitest";
import { reduceInterleavedIntoBins, trimPeaks } from "../peaksMediabunny";

describe("trimPeaks", () => {
  const BPS = 2000;

  it("clamps AAC decode padding to the bins' true span (the FR7 drift case)", () => {
    // 6.000 s of bins, decoder emitted padding through 6.016 s.
    const { peaks, duration } = trimPeaks(new Float32Array(12000), 6.016, BPS);
    expect(peaks.length).toBe(12000);
    expect(duration).toBe(6.0); // NOT 6.016 — that stretched the axis 0.27%
  });

  it("trims to the decoded extent when decode comes up short", () => {
    const { peaks, duration } = trimPeaks(new Float32Array(12000), 5.9, BPS);
    expect(peaks.length).toBe(11800);
    expect(duration).toBeCloseTo(5.9, 10);
  });

  it("keeps the painter's axis invariant: length / duration === binsPerSec (to float precision)", () => {
    for (const end of [6.016, 5.9, 6.0, 0.0001]) {
      const { peaks, duration } = trimPeaks(new Float32Array(12000), end, BPS);
      expect(peaks.length / duration).toBeCloseTo(BPS, 6);
    }
  });

  it("never returns zero bins", () => {
    const { peaks } = trimPeaks(new Float32Array(12000), 1e-9, BPS);
    expect(peaks.length).toBe(1);
  });
});

// 4 frames/bin at these rates: sampleRate 8, binsPerSec 2.
const RATE = 8;
const BPS = 2;

describe("reduceInterleavedIntoBins", () => {
  it("max-reduces mono frames into the right bins", () => {
    const bins = new Float32Array(2);
    // Frames 0..7 → bins 0 (frames 0–3) and 1 (frames 4–7).
    const data = new Float32Array([0.1, -0.5, 0.2, 0.0, 0.3, -0.9, 0.1, 0.2]);
    reduceInterleavedIntoBins(bins, data, 1, 0, RATE, BPS);
    expect(bins[0]).toBeCloseTo(0.5); // |-0.5| is the loudest of frames 0–3
    expect(bins[1]).toBeCloseTo(0.9);
  });

  it("mean-downmixes channels per frame before taking |amp| (ffmpeg -ac 1 parity)", () => {
    const bins = new Float32Array(1);
    // One stereo frame: L=1, R=-1 → mean 0, NOT max-per-channel 1.
    reduceInterleavedIntoBins(bins, new Float32Array([1, -1]), 2, 0, RATE, BPS);
    expect(bins[0]).toBe(0);

    // L=-0.6, R=-0.2 → mean -0.4 → amp 0.4.
    reduceInterleavedIntoBins(bins, new Float32Array([-0.6, -0.2]), 2, 0, RATE, BPS);
    expect(bins[0]).toBeCloseTo(0.4);
  });

  it("honors baseFrame when placing a later chunk", () => {
    const bins = new Float32Array(2);
    // A chunk that starts at frame 4 lands in bin 1, leaving bin 0 untouched.
    reduceInterleavedIntoBins(bins, new Float32Array([0.7]), 1, 4, RATE, BPS);
    expect(bins[0]).toBe(0);
    expect(bins[1]).toBeCloseTo(0.7);
  });

  it("accumulates max across multiple chunks into the same bin", () => {
    const bins = new Float32Array(1);
    reduceInterleavedIntoBins(bins, new Float32Array([0.3]), 1, 0, RATE, BPS);
    reduceInterleavedIntoBins(bins, new Float32Array([0.8]), 1, 1, RATE, BPS);
    reduceInterleavedIntoBins(bins, new Float32Array([0.5]), 1, 2, RATE, BPS);
    expect(bins[0]).toBeCloseTo(0.8);
  });

  it("drops frames outside the bin range instead of throwing", () => {
    const bins = new Float32Array(1);
    // Frames 4+ map to bin 1, which doesn't exist — silently dropped.
    reduceInterleavedIntoBins(bins, new Float32Array([0.2, 0.9]), 1, 3, RATE, BPS);
    expect(bins[0]).toBeCloseTo(0.2);
    // Negative baseFrame (decoder pre-roll) — negative bins dropped too.
    reduceInterleavedIntoBins(bins, new Float32Array([0.6, 0.4]), 1, -1, RATE, BPS);
    expect(bins[0]).toBeCloseTo(0.4); // frame -1 dropped, frame 0 lands
  });

  it("handles zero channels without dividing by zero", () => {
    const bins = new Float32Array(1);
    reduceInterleavedIntoBins(bins, new Float32Array([0.5]), 0, 0, RATE, BPS);
    expect(bins[0]).toBe(0);
  });
});
