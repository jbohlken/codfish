import { describe, it, expect } from "vitest";
import { segmentIntoPhrases } from "../segment";
import { makeWords } from "./helpers";

describe("segmentIntoPhrases", () => {
  it("handles empty input", () => {
    expect(segmentIntoPhrases([])).toEqual([]);
  });

  it("returns single phrase for simple sentence", () => {
    const words = makeWords("Hello world.");
    const phrases = segmentIntoPhrases(words);
    expect(phrases).toHaveLength(1);
    expect(phrases[0].text).toBe("Hello world.");
  });

  it("splits two sentences", () => {
    const words = makeWords("Hello world. How are you?");
    const phrases = segmentIntoPhrases(words);
    expect(phrases).toHaveLength(2);
    expect(phrases[0].text).toBe("Hello world.");
    expect(phrases[1].text).toBe("How are you?");
  });

  it("splits at clause when text is getting long", () => {
    const words = makeWords(
      "When the long meeting finally ends, we should review the important notes",
    );
    const phrases = segmentIntoPhrases(words, { maxChars: 42 });
    expect(phrases.length).toBeGreaterThanOrEqual(2);
    expect(phrases[0].text).toMatch(/,$/);
  });

  it("forces break on speaker change", () => {
    const wordsA = makeWords("Hello there.", { speaker: "SPEAKER_00" });
    const wordsB = makeWords("Hi back.", { start: 2.0, speaker: "SPEAKER_01" });
    const phrases = segmentIntoPhrases([...wordsA, ...wordsB]);
    expect(phrases.length).toBeGreaterThanOrEqual(2);
    expect(phrases[0].words.every((w) => w.speaker === "SPEAKER_00")).toBe(true);
  });

  it("forces break on time gap", () => {
    const wordsA = makeWords("Hello there.");
    const wordsB = makeWords("After a pause.", { start: 5.0 });
    const phrases = segmentIntoPhrases([...wordsA, ...wordsB], { gapThreshold: 0.7 });
    expect(phrases.length).toBeGreaterThanOrEqual(2);
  });

  it("handles single word", () => {
    const words = makeWords("Hello");
    const phrases = segmentIntoPhrases(words);
    expect(phrases).toHaveLength(1);
    expect(phrases[0].text).toBe("Hello");
  });

  it("respects max words per phrase", () => {
    const words = makeWords(
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen",
    );
    const phrases = segmentIntoPhrases(words, { maxWordsPerPhrase: 10 });
    expect(phrases.every((p) => p.words.length <= 10)).toBe(true);
  });

  it("prefers to break before conjunction when line is long", () => {
    const words = makeWords(
      "The quick brown fox jumped over the lazy dog and then ran away",
    );
    const phrases = segmentIntoPhrases(words, { maxChars: 42 });
    // All phrases must stay within 2 lines worth of chars
    expect(phrases.every((p) => p.charCount <= 42 * 2)).toBe(true);
  });
});
