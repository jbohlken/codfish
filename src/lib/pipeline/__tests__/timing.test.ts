import { describe, it, expect } from "vitest";
import { snapToFrame, framesBetween, enforceTiming } from "../timing";
import { makeWords, makeBlock } from "./helpers";
import type { TimingConfig } from "../../../types/profile";

const baseConfig: TimingConfig = {
  minDuration: { value: 0.0, strict: false },
  maxDuration: { value: 6.0, strict: false },
  extendToFill: false,
  extendToFillMax: 0.5,
  gapCloseThreshold: 0.5,
  minGapSeconds: { value: 0.4, strict: true },
  defaultFps: 30.0,
};

describe("snapToFrame", () => {
  it("snaps whole second at 30fps", () => {
    expect(snapToFrame(1.0, 30.0)).toBe(1.0);
  });

  it("snaps near-frame boundary down", () => {
    expect(snapToFrame(1.016, 30.0)).toBe(1.0);
  });

  it("snaps near-frame boundary up", () => {
    expect(snapToFrame(1.034, 30.0)).toBeCloseTo(1 + 1 / 30, 10);
  });

  it("snaps at 24fps", () => {
    expect(snapToFrame(0.05, 24.0)).toBeCloseTo(1 / 24, 3);
  });

  it("snaps at 60fps", () => {
    expect(snapToFrame(0.5, 60.0)).toBe(0.5);
  });
});

describe("framesBetween", () => {
  it("counts 30 frames in 1 second at 30fps", () => {
    expect(framesBetween(0.0, 1.0, 30.0)).toBe(30);
  });

  it("counts 15 frames in 0.5 seconds", () => {
    expect(framesBetween(0.0, 0.5, 30.0)).toBe(15);
  });

  it("returns 0 for zero gap", () => {
    expect(framesBetween(1.0, 1.0, 30.0)).toBe(0);
  });
});

describe("enforceTiming", () => {
  it("extends short caption to min duration", () => {
    const words = makeWords("Hello");
    const block = makeBlock(1, 0.0, 0.3, ["Hello"], words);
    const result = enforceTiming([block], { ...baseConfig, minDuration: { value: 1.0, strict: false } });
    expect(result[0].end - result[0].start).toBeGreaterThanOrEqual(1.0);
  });

  it("leaves short caption alone when min_duration is 0", () => {
    const words = makeWords("Hi");
    const block = makeBlock(1, 0.0, 0.3, ["Hi"], words);
    const result = enforceTiming([block], { ...baseConfig, extendToFill: false });
    expect(result[0].end - result[0].start).toBeLessThan(0.5);
  });

  it("closes flicker-zone gap to 0", () => {
    const wordsA = makeWords("Hello there");
    const wordsB = makeWords("my friend", { start: 0.75 });
    const blockA = makeBlock(1, 0.0, 0.7, ["Hello there"], wordsA);
    const blockB = makeBlock(2, 0.73, 1.5, ["my friend"], wordsB);
    const result = enforceTiming([blockA, blockB], baseConfig);
    const gap = framesBetween(result[0].end, result[1].start, 30.0);
    expect(gap === 0 || gap >= 12).toBe(true);
  });

  it("does not delay next caption when enforcing gaps", () => {
    const wordsA = makeWords("Hello.");
    const wordsB = makeWords("After pause.", { start: 2.0 });
    const blockA = makeBlock(1, 0.0, 0.7, ["Hello."], wordsA);
    const blockB = makeBlock(2, 0.8, 2.5, ["After pause."], wordsB);
    const result = enforceTiming([blockA, blockB], baseConfig);
    expect(result[1].start).toBeCloseTo(snapToFrame(0.8, 30.0), 5);
  });

  it("produces no overlaps", () => {
    const wordsA = makeWords("First block.");
    const wordsB = makeWords("Second block.", { start: 1.0 });
    const wordsC = makeWords("Third block.", { start: 2.0 });
    const blocks = [
      makeBlock(1, 0.0, 1.1, ["First block."], wordsA),
      makeBlock(2, 1.0, 2.1, ["Second block."], wordsB),
      makeBlock(3, 2.0, 3.0, ["Third block."], wordsC),
    ];
    const result = enforceTiming(blocks, baseConfig);
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].end).toBeLessThanOrEqual(result[i + 1].start);
    }
  });

  it("ensures positive duration", () => {
    const words = makeWords("Short");
    const block = makeBlock(1, 0.0, 0.01, ["Short"], words);
    const result = enforceTiming([block], baseConfig);
    expect(result[0].end - result[0].start).toBeGreaterThan(0);
  });

  it("snaps to source fps", () => {
    const words = makeWords("Test");
    const block = makeBlock(1, 0.0, 0.5, ["Test"], words);
    const result = enforceTiming([block], baseConfig, 24.0);
    expect(result[0].start * 24).toBeCloseTo(Math.round(result[0].start * 24), 5);
  });

  it("extends into dead time when extend_to_fill is on", () => {
    const wordsA = makeWords("First.");
    const wordsB = makeWords("Second.", { start: 3.0 });
    const blockA = makeBlock(1, 0.0, 0.5, ["First."], wordsA);
    const blockB = makeBlock(2, 3.0, 3.5, ["Second."], wordsB);
    const result = enforceTiming([blockA, blockB], {
      ...baseConfig,
      extendToFill: true,
      extendToFillMax: 0.5,
    });
    expect(result[0].end).toBeGreaterThan(0.5);
    expect(result[0].end - result[0].start).toBeLessThanOrEqual(1.1);
  });

  it("caps extension at available gap", () => {
    const wordsA = makeWords("First.");
    const wordsB = makeWords("Second.", { start: 0.7 });
    const blockA = makeBlock(1, 0.0, 0.5, ["First."], wordsA);
    const blockB = makeBlock(2, 0.7, 1.2, ["Second."], wordsB);
    const result = enforceTiming([blockA, blockB], {
      ...baseConfig,
      extendToFill: true,
      extendToFillMax: 0.5,
    });
    expect(result[0].end).toBeLessThanOrEqual(result[1].start);
  });

  it("does not extend when extend_to_fill is off", () => {
    const wordsA = makeWords("First.");
    const wordsB = makeWords("Second.", { start: 3.0 });
    const blockA = makeBlock(1, 0.0, 0.5, ["First."], wordsA);
    const blockB = makeBlock(2, 3.0, 3.5, ["Second."], wordsB);
    const result = enforceTiming([blockA, blockB], {
      ...baseConfig,
      extendToFill: false,
    });
    expect(result[0].end - result[0].start).toBeLessThan(0.6);
  });
});
