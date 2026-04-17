import { describe, it, expect } from "vitest";
import { validate } from "../validate";
import { makeBlock } from "./helpers";
import type { CaptionProfile } from "../../../types/profile";

const baseProfile: CaptionProfile = {
  id: "test",
  name: "Test",
  description: "",
  builtIn: false,
  timing: {
    minDuration: { value: 0.5, strict: true, unit: "s" },
    maxDuration: { value: 6.0, strict: true, unit: "s" },
    maxCps: { value: 20, strict: false },
    extendToFill: false,
    extendToFillMax: 0.5,
    gapCloseThreshold: 0.5,
    minGapEnabled: true,
    minGapSeconds: { value: 0.4, strict: true, unit: "s" },
    defaultFps: 30,
  },
  formatting: {
    maxCharsPerLine: { value: 42, strict: false },
    maxLines: { value: 2, strict: true },
  },
  merge: { enabled: false, phraseBreakGap: 0.7, minSegmentWords: 3, mergeGapThreshold: 0.5 },
};

describe("validate", () => {
  it("returns no warnings for valid captions", () => {
    const blocks = [
      makeBlock(1, 0.0, 2.0, ["Hello there"]),
      makeBlock(2, 3.0, 5.0, ["How are you"]),
    ];
    const { warnings } = validate(blocks, baseProfile);
    expect(warnings).toHaveLength(0);
  });

  it("detects overlap", () => {
    const blocks = [
      makeBlock(1, 0.0, 2.0, ["First"]),
      makeBlock(2, 1.5, 3.0, ["Second"]),
    ];
    const { warnings } = validate(blocks, baseProfile);
    const overlap = warnings.find((w) => w.rule === "overlap");
    expect(overlap).toBeDefined();
    expect(overlap!.strict).toBe(true);
    expect(overlap!.blockIndex).toBe(1);
  });

  it("detects flicker gap", () => {
    const blocks = [
      makeBlock(1, 0.0, 2.0, ["First"]),
      makeBlock(2, 2.1, 4.0, ["Second"]), // 0.1s gap, below 0.4s min
    ];
    const { warnings } = validate(blocks, baseProfile);
    const flicker = warnings.find((w) => w.rule === "gap_flicker");
    expect(flicker).toBeDefined();
    expect(flicker!.blockIndex).toBe(1);
  });

  it("allows seamless captions (gap = 0)", () => {
    const blocks = [
      makeBlock(1, 0.0, 2.0, ["First"]),
      makeBlock(2, 2.0, 4.0, ["Second"]),
    ];
    const { warnings } = validate(blocks, baseProfile);
    expect(warnings.filter((w) => w.rule === "gap_flicker")).toHaveLength(0);
    expect(warnings.filter((w) => w.rule === "overlap")).toHaveLength(0);
  });

  it("allows gaps above minimum", () => {
    const blocks = [
      makeBlock(1, 0.0, 2.0, ["First"]),
      makeBlock(2, 2.5, 4.0, ["Second"]), // 0.5s gap, above 0.4s min
    ];
    const { warnings } = validate(blocks, baseProfile);
    expect(warnings.filter((w) => w.rule === "gap_flicker")).toHaveLength(0);
  });

  it("detects min duration violation", () => {
    const blocks = [makeBlock(1, 0.0, 0.2, ["Hi"])]; // 0.2s < 0.5s min
    const { warnings } = validate(blocks, baseProfile);
    const minDur = warnings.find((w) => w.rule === "min_duration");
    expect(minDur).toBeDefined();
    expect(minDur!.strict).toBe(true);
  });

  it("detects max duration violation", () => {
    const blocks = [makeBlock(1, 0.0, 7.0, ["Very long caption"])]; // 7s > 6s max
    const { warnings } = validate(blocks, baseProfile);
    const maxDur = warnings.find((w) => w.rule === "max_duration");
    expect(maxDur).toBeDefined();
  });

  it("detects reading speed violation", () => {
    // 50 chars in 1 second = 50 CPS, well above 20 CPS limit
    const blocks = [makeBlock(1, 0.0, 1.0, ["A".repeat(50)])];
    const { warnings } = validate(blocks, baseProfile);
    const cps = warnings.find((w) => w.rule === "reading_speed");
    expect(cps).toBeDefined();
    expect(cps!.actualValue).toBeGreaterThan(20);
  });

  it("detects max lines violation", () => {
    const blocks = [makeBlock(1, 0.0, 2.0, ["Line 1", "Line 2", "Line 3"])]; // 3 lines > 2 max
    const { warnings } = validate(blocks, baseProfile);
    const maxLines = warnings.find((w) => w.rule === "max_lines");
    expect(maxLines).toBeDefined();
    expect(maxLines!.strict).toBe(true);
  });

  it("detects chars per line violation", () => {
    const blocks = [makeBlock(1, 0.0, 2.0, ["A".repeat(50)])]; // 50 > 42 max
    const { warnings } = validate(blocks, baseProfile);
    const cpl = warnings.find((w) => w.rule === "chars_per_line");
    expect(cpl).toBeDefined();
  });

  it("detects line balance issue", () => {
    const blocks = [makeBlock(1, 0.0, 3.0, ["Short", "This is a much longer second line"])];
    const { warnings } = validate(blocks, baseProfile);
    const balance = warnings.find((w) => w.rule === "line_balance");
    expect(balance).toBeDefined();
    expect(balance!.strict).toBe(false);
  });

  it("does not flag balanced lines", () => {
    const blocks = [makeBlock(1, 0.0, 3.0, ["Hello there my friend", "How are you doing today"])];
    const { warnings } = validate(blocks, baseProfile);
    expect(warnings.filter((w) => w.rule === "line_balance")).toHaveLength(0);
  });

  it("sorts strict warnings before fuzzy", () => {
    const blocks = [
      makeBlock(1, 0.0, 0.2, ["A".repeat(50)]), // min duration (strict), chars_per_line (fuzzy), reading_speed (fuzzy)
    ];
    const { warnings } = validate(blocks, baseProfile);
    expect(warnings.length).toBeGreaterThan(1);
    // Strict warnings come first
    const firstFuzzyIdx = warnings.findIndex((w) => !w.strict);
    let lastStrictIdx = -1;
    for (let i = warnings.length - 1; i >= 0; i--) {
      if (warnings[i].strict) { lastStrictIdx = i; break; }
    }
    if (firstFuzzyIdx >= 0 && lastStrictIdx >= 0) {
      expect(lastStrictIdx).toBeLessThan(firstFuzzyIdx);
    }
  });

  it("uses source fps when provided", () => {
    // 2 frames at 24fps = 0.0833s gap — well below 0.4s min, should trigger flicker
    const blocks = [
      makeBlock(1, 0.0, 2.0, ["First"]),
      makeBlock(2, 2.08, 4.0, ["Second"]),
    ];
    const { warnings } = validate(blocks, baseProfile, 24);
    const flicker = warnings.find((w) => w.rule === "gap_flicker");
    expect(flicker).toBeDefined();
  });

  it("returns totalBlocks count", () => {
    const blocks = [
      makeBlock(1, 0.0, 2.0, ["A"]),
      makeBlock(2, 3.0, 5.0, ["B"]),
      makeBlock(3, 6.0, 8.0, ["C"]),
    ];
    const report = validate(blocks, baseProfile);
    expect(report.totalBlocks).toBe(3);
  });

  it("skips min duration check when min is 0", () => {
    const profile = {
      ...baseProfile,
      timing: { ...baseProfile.timing, minDuration: { value: 0, strict: true, unit: "s" as const } },
    };
    const blocks = [makeBlock(1, 0.0, 0.01, ["Hi"])];
    const { warnings } = validate(blocks, profile);
    expect(warnings.filter((w) => w.rule === "min_duration")).toHaveLength(0);
  });

  it("respects disabled min gap", () => {
    const profile = {
      ...baseProfile,
      timing: { ...baseProfile.timing, minGapEnabled: false },
    };
    const blocks = [
      makeBlock(1, 0.0, 2.0, ["First"]),
      makeBlock(2, 2.1, 4.0, ["Second"]), // 0.1s gap — would trigger flicker if enabled
    ];
    const { warnings } = validate(blocks, profile);
    expect(warnings.filter((w) => w.rule === "gap_flicker")).toHaveLength(0);
  });
});
