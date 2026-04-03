import { describe, it, expect } from "vitest";
import { breakIntoLines, formatPhraseToCaptionLines } from "../linebreak";
import { makePhrase } from "../types";
import { makeWords } from "./helpers";

describe("breakIntoLines", () => {
  it("returns empty for empty phrase", () => {
    expect(breakIntoLines(makePhrase([]))).toEqual([]);
  });

  it("keeps single word on one line", () => {
    expect(breakIntoLines(makePhrase(makeWords("Hello")))).toEqual(["Hello"]);
  });

  it("keeps short text on one line", () => {
    expect(breakIntoLines(makePhrase(makeWords("Hello world")))).toEqual(["Hello world"]);
  });

  it("breaks at comma", () => {
    const phrase = makePhrase(makeWords("When the meeting ends, we should review the notes"));
    const lines = breakIntoLines(phrase, 42);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("When the meeting ends,");
    expect(lines[1]).toBe("we should review the notes");
  });

  it("never ends a line with an article", () => {
    const phrase = makePhrase(makeWords("She went to the store to buy some groceries"));
    const lines = breakIntoLines(phrase, 30);
    const articles = new Set(["a", "an", "the", "this", "that", "these", "those"]);
    for (const line of lines) {
      const last = line.split(" ").at(-1)!.toLowerCase().replace(/[,.;:]$/, "");
      expect(articles.has(last), `Line ends with article: "${line}"`).toBe(false);
    }
  });

  it("never ends a line with a preposition", () => {
    const phrase = makePhrase(makeWords("He walked to the park with his friend"));
    const lines = breakIntoLines(phrase, 25);
    const preps = new Set(["to", "with", "for", "from", "in", "on", "at", "by", "of"]);
    for (const line of lines) {
      const last = line.split(" ").at(-1)!.toLowerCase().replace(/[,.;:]$/, "");
      expect(preps.has(last), `Line ends with preposition: "${line}"`).toBe(false);
    }
  });

  it("produces reasonably balanced lines", () => {
    const phrase = makePhrase(makeWords("The quick brown fox jumped over the lazy dog"));
    const lines = breakIntoLines(phrase, 42);
    if (lines.length === 2) {
      const ratio = Math.min(lines[0].length, lines[1].length) /
                    Math.max(lines[0].length, lines[1].length);
      expect(ratio).toBeGreaterThan(0.3);
    }
  });

  it("avoids orphan single word on line 2", () => {
    const phrase = makePhrase(makeWords("The Medicare Prescription Payment Plan."));
    const lines = breakIntoLines(phrase, 42);
    if (lines.length === 2) {
      expect(lines[1].split(" ").length).toBeGreaterThanOrEqual(2);
    }
  });

  it("avoids severely unbalanced split", () => {
    const phrase = makePhrase(makeWords("Well I'm here to help you understand these changes"));
    const lines = breakIntoLines(phrase, 42);
    if (lines.length === 2) {
      const ratio = Math.min(lines[0].length, lines[1].length) /
                    Math.max(lines[0].length, lines[1].length);
      expect(ratio).toBeGreaterThan(0.2);
    }
  });
});

describe("formatPhraseToCaptionLines", () => {
  it("never exceeds max_lines", () => {
    const phrase = makePhrase(makeWords("A very long sentence that keeps going and going"));
    const lines = formatPhraseToCaptionLines(phrase, 42, 2);
    expect(lines.length).toBeLessThanOrEqual(2);
  });
});
