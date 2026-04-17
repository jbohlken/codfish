import { describe, it, expect } from "vitest";
import { enforceTiming } from "../timing";
import { snapToFrame, framesBetween, EPSILON } from "../../time";
import { validate } from "../validate";
import { makeWords, makeBlock } from "./helpers";
import type { TimingConfig } from "../../../types/profile";
import type { CaptionProfile } from "../../../types/profile";

const baseConfig: TimingConfig = {
  minDuration: { value: 0.0, strict: false, unit: "s" },
  maxDuration: { value: 6.0, strict: false, unit: "s" },
  maxCps: { value: 20.0, strict: false },
  extendToFill: false,
  extendToFillMax: 0.5,
  gapCloseThreshold: 0.5,
  minGapEnabled: true,
  minGapSeconds: { value: 0.4, strict: true, unit: "s" },
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
    const result = enforceTiming([block], { ...baseConfig, minDuration: { value: 1.0, strict: false, unit: "s" } });
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

  it("snaps correctly at 29.97fps", () => {
    const words = makeWords("Test");
    const block = makeBlock(1, 0.0, 0.5, ["Test"], words);
    const result = enforceTiming([block], baseConfig, 29.97);
    // Verify frame-aligned
    const startFrame = Math.round(result[0].start * 29.97);
    const endFrame = Math.round(result[0].end * 29.97);
    expect(result[0].start).toBeCloseTo(startFrame / 29.97, 10);
    expect(result[0].end).toBeCloseTo(endFrame / 29.97, 10);
  });

  it("produces no phantom overlaps at 29.97fps (stress test)", () => {
    // Generate 100+ tightly-spaced blocks at 29.97fps
    const blocks = [];
    for (let i = 0; i < 120; i++) {
      const start = i * 1.5;
      const end = start + 1.2;
      const words = makeWords(`Caption ${i}`, { start });
      blocks.push(makeBlock(i + 1, start, end, [`Caption ${i}`], words));
    }

    const result = enforceTiming(blocks, {
      ...baseConfig,
      minGapEnabled: true,
      minGapSeconds: { value: 2, strict: true, unit: "fr" },
      extendToFill: true,
      extendToFillMax: 0.3,
    }, 29.97);

    // No overlaps: every block's end must be <= next block's start (within epsilon)
    for (let i = 0; i < result.length - 1; i++) {
      const gap = result[i + 1].start - result[i].end;
      expect(gap).toBeGreaterThanOrEqual(-EPSILON);
    }

    // Every block has positive duration
    for (const block of result) {
      expect(block.end - block.start).toBeGreaterThan(0);
    }
  });

  it("enforceTiming → validate produces no overlap warnings at 29.97fps", () => {
    const blocks = [];
    for (let i = 0; i < 50; i++) {
      const start = i * 2.0;
      const end = start + 1.5;
      const words = makeWords(`Block number ${i}`, { start });
      blocks.push(makeBlock(i + 1, start, end, [`Block number ${i}`], words));
    }

    const config29: TimingConfig = {
      ...baseConfig,
      defaultFps: 29.97,
      extendToFill: true,
      extendToFillMax: 0.5,
    };

    const profile: CaptionProfile = {
      id: "test",
      name: "Test",
      description: "",
      builtIn: false,
      timing: config29,
      formatting: { maxCharsPerLine: { value: 42, strict: false }, maxLines: { value: 2, strict: false } },
      merge: { enabled: false, phraseBreakGap: 0.7, minSegmentWords: 3, mergeGapThreshold: 0.5 },
    };

    const result = enforceTiming(blocks, config29, 29.97);
    const report = validate(result, profile, 29.97);
    const overlaps = report.warnings.filter((w) => w.rule === "overlap");
    expect(overlaps).toHaveLength(0);
  });
});
