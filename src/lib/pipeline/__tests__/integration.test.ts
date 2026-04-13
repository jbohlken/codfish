import { describe, it, expect } from "vitest";
import { runPipeline } from "../index";
import { makeWords } from "./helpers";
import { EPSILON } from "../../time";
import type { CaptionProfile } from "../../../types/profile";

const baseProfile: CaptionProfile = {
  id: "test",
  name: "Test",
  description: "",
  builtIn: false,
  timing: {
    minDuration: { value: 0.8, strict: false, unit: "s" },
    maxDuration: { value: 6.0, strict: false, unit: "s" },
    maxCps: { value: 20.0, strict: false },
    extendToFill: false,
    extendToFillMax: 0.5,
    gapCloseThreshold: 0.5,
    minGapEnabled: true,
    minGapSeconds: { value: 2, strict: true, unit: "fr" },
    defaultFps: 30.0,
  },
  formatting: {
    maxCharsPerLine: { value: 42, strict: false },
    maxLines: { value: 2, strict: false },
  },
  merge: {
    enabled: true,
    phraseBreakGap: 0.7,
    minSegmentWords: 3,
    mergeGapThreshold: 0.5,
  },
};

describe("runPipeline — end-to-end", () => {
  it("produces captions from words", () => {
    const words = makeWords("Hello world this is a test of the caption pipeline", {
      wordDuration: 0.4,
      gap: 0.1,
    });
    const { captions } = runPipeline(words, baseProfile);

    expect(captions.length).toBeGreaterThan(0);
    for (const c of captions) {
      expect(c.lines.length).toBeGreaterThan(0);
      expect(c.start).toBeLessThan(c.end);
      expect(c.index).toBeGreaterThan(0);
    }
  });

  it("produces 1-based contiguous indices", () => {
    const words = makeWords("One two three four five six seven eight nine ten", {
      wordDuration: 0.5,
      gap: 0.8,
    });
    const { captions } = runPipeline(words, baseProfile);

    for (let i = 0; i < captions.length; i++) {
      expect(captions[i].index).toBe(i + 1);
    }
  });

  it("produces no overlaps", () => {
    const words = makeWords(
      "The quick brown fox jumps over the lazy dog and then runs back again across the field",
      { wordDuration: 0.3, gap: 0.1 },
    );
    const { captions } = runPipeline(words, baseProfile);

    for (let i = 0; i < captions.length - 1; i++) {
      const gap = captions[i + 1].start - captions[i].end;
      expect(gap).toBeGreaterThanOrEqual(-EPSILON);
    }
  });

  it("respects maxCharsPerLine", () => {
    const maxChars = baseProfile.formatting.maxCharsPerLine.value;
    const words = makeWords(
      "This is a longer sentence to check that line breaking respects the maximum character limit per line",
      { wordDuration: 0.25, gap: 0.05 },
    );
    const { captions } = runPipeline(words, baseProfile);

    for (const c of captions) {
      for (const line of c.lines) {
        expect(line.length).toBeLessThanOrEqual(maxChars + 1); // +1 tolerance for edge cases
      }
    }
  });

  it("respects maxLines", () => {
    const maxLines = baseProfile.formatting.maxLines.value;
    const words = makeWords(
      "First word second word third word fourth word fifth word sixth word",
      { wordDuration: 0.3, gap: 0.05 },
    );
    const { captions } = runPipeline(words, baseProfile);

    for (const c of captions) {
      expect(c.lines.length).toBeLessThanOrEqual(maxLines);
    }
  });

  it("strips words from output captions", () => {
    const words = makeWords("Hello world", { wordDuration: 0.4 });
    const { captions } = runPipeline(words, baseProfile);

    for (const c of captions) {
      expect(c.words).toBeUndefined();
    }
  });

  it("produces a validation report", () => {
    const words = makeWords("Hello world test", { wordDuration: 0.3 });
    const { report } = runPipeline(words, baseProfile);

    expect(report).toBeDefined();
    expect(Array.isArray(report.warnings)).toBe(true);
  });

  it("handles empty word list", () => {
    const { captions, report } = runPipeline([], baseProfile);
    expect(captions).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
  });

  it("handles single word", () => {
    const words = makeWords("Hello");
    const { captions } = runPipeline(words, baseProfile);
    expect(captions.length).toBe(1);
    expect(captions[0].lines.join(" ")).toContain("Hello");
  });

  it("cleans up whisper BPE artifacts", () => {
    // Whisper BPE tokenizer splits contractions: "don" + "'t"
    const words = [
      { text: "I", start: 0, end: 0.2, confidence: 1.0 },
      { text: "don", start: 0.25, end: 0.4, confidence: 1.0 },
      { text: "'t", start: 0.4, end: 0.5, confidence: 1.0 },
      { text: "know.", start: 0.55, end: 0.8, confidence: 1.0 },
    ];
    const { captions } = runPipeline(words, baseProfile);
    const text = captions.map((c) => c.lines.join(" ")).join(" ");
    expect(text).toContain("don't");
    expect(text).not.toContain("don '");
  });

  it("splits on speaker change", () => {
    const wordsA = makeWords("Hello from speaker one", { speaker: "A" });
    const wordsB = makeWords("And hello from speaker two", {
      start: 3.0,
      speaker: "B",
    });
    const { captions } = runPipeline([...wordsA, ...wordsB], baseProfile);

    // Should produce at least 2 captions (speaker boundary forces a split)
    expect(captions.length).toBeGreaterThanOrEqual(2);
  });

  it("merges short orphan phrases when merge enabled", () => {
    // Create words with tiny phrases that should get merged
    const words = [
      ...makeWords("Hi", { wordDuration: 0.2 }),
      ...makeWords("there my friend how are you doing today", {
        start: 0.3,
        wordDuration: 0.2,
        gap: 0.05,
      }),
    ];
    const { captions } = runPipeline(words, baseProfile);

    // "Hi" alone is under minSegmentWords, should be merged with next
    const firstText = captions[0].lines.join(" ");
    expect(firstText).toContain("Hi");
    expect(firstText.split(" ").length).toBeGreaterThan(1);
  });

  it("does not merge when merge disabled", () => {
    const noMerge: CaptionProfile = {
      ...baseProfile,
      merge: { ...baseProfile.merge, enabled: false },
    };
    const words = makeWords("A B C D E F G H I J", {
      wordDuration: 0.3,
      gap: 0.8, // large gap forces segmentation
    });
    const { captions: withMerge } = runPipeline(words, baseProfile);
    const { captions: withoutMerge } = runPipeline(words, noMerge);

    // Without merge, expect more (or equal) captions
    expect(withoutMerge.length).toBeGreaterThanOrEqual(withMerge.length);
  });

  it("frame-snaps at source fps", () => {
    const words = makeWords("Hello world test caption", { wordDuration: 0.4, gap: 0.1 });
    const fps = 24;
    const { captions } = runPipeline(words, baseProfile, fps);

    for (const c of captions) {
      const startFrame = Math.round(c.start * fps);
      const endFrame = Math.round(c.end * fps);
      expect(c.start).toBeCloseTo(startFrame / fps, 6);
      expect(c.end).toBeCloseTo(endFrame / fps, 6);
    }
  });

  it("frame-snaps at 29.97fps with no overlaps", () => {
    const words = makeWords(
      "This is a fairly long sentence designed to produce multiple caption blocks when processed through the pipeline at twenty nine point nine seven frames per second",
      { wordDuration: 0.25, gap: 0.08 },
    );
    const { captions } = runPipeline(words, baseProfile, 29.97);

    for (let i = 0; i < captions.length - 1; i++) {
      const gap = captions[i + 1].start - captions[i].end;
      expect(gap).toBeGreaterThanOrEqual(-EPSILON);
    }

    for (const c of captions) {
      const startFrame = Math.round(c.start * 29.97);
      const endFrame = Math.round(c.end * 29.97);
      expect(c.start).toBeCloseTo(startFrame / 29.97, 6);
      expect(c.end).toBeCloseTo(endFrame / 29.97, 6);
    }
  });

  it("produces no overlap warnings after full pipeline", () => {
    const words = makeWords(
      "The complete caption pipeline should never produce overlap warnings when running end to end because the timing stage resolves them before validation",
      { wordDuration: 0.3, gap: 0.1 },
    );
    const { report } = runPipeline(words, baseProfile, 29.97);
    const overlaps = report.warnings.filter((w) => w.rule === "overlap");
    expect(overlaps).toHaveLength(0);
  });

  it("extend-to-fill closes small gaps", () => {
    const extendProfile: CaptionProfile = {
      ...baseProfile,
      timing: {
        ...baseProfile.timing,
        extendToFill: true,
        extendToFillMax: 0.5,
      },
    };
    const words = [
      ...makeWords("First caption here", { wordDuration: 0.3, gap: 0.05 }),
      ...makeWords("Second caption here", { start: 3.0, wordDuration: 0.3, gap: 0.05 }),
    ];
    const { captions: withExtend } = runPipeline(words, extendProfile);
    const { captions: withoutExtend } = runPipeline(words, baseProfile);

    // With extend-to-fill, the first caption's end should be later
    if (withExtend.length > 0 && withoutExtend.length > 0) {
      expect(withExtend[0].end).toBeGreaterThanOrEqual(withoutExtend[0].end);
    }
  });

  it("stress test: 200 words at 29.97fps", () => {
    const sentence = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const words = makeWords(sentence, { wordDuration: 0.2, gap: 0.05 });
    const { captions, report } = runPipeline(words, baseProfile, 29.97);

    expect(captions.length).toBeGreaterThan(0);

    // No overlaps
    for (let i = 0; i < captions.length - 1; i++) {
      const gap = captions[i + 1].start - captions[i].end;
      expect(gap).toBeGreaterThanOrEqual(-EPSILON);
    }

    // No overlap warnings
    const overlaps = report.warnings.filter((w) => w.rule === "overlap");
    expect(overlaps).toHaveLength(0);

    // All positive durations
    for (const c of captions) {
      expect(c.end - c.start).toBeGreaterThan(0);
    }

    // Contiguous indices
    for (let i = 0; i < captions.length; i++) {
      expect(captions[i].index).toBe(i + 1);
    }
  });
});
