import { describe, it, expect } from "vitest";
import { cleanWords } from "../cleanup";
import type { Word } from "../../../types/project";

function texts(words: Word[]): string[] {
  return words.map((w) => w.text);
}

describe("cleanWords — hyphen joining", () => {
  it("merges compound words", () => {
    const words: Word[] = [
      { text: "out", start: 0.0, end: 0.3, confidence: 1 },
      { text: "-of", start: 0.3, end: 0.6, confidence: 1 },
      { text: "-pocket", start: 0.6, end: 0.9, confidence: 1 },
    ];
    expect(texts(cleanWords(words))).toEqual(["out-of-pocket"]);
  });

  it("preserves timestamps across merge", () => {
    const words: Word[] = [
      { text: "out", start: 1.0, end: 1.3, confidence: 1 },
      { text: "-of", start: 1.3, end: 1.6, confidence: 1 },
      { text: "-pocket", start: 1.6, end: 2.0, confidence: 1 },
    ];
    const result = cleanWords(words);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe(1.0);
    expect(result[0].end).toBe(2.0);
  });
});

describe("cleanWords — comma in numbers", () => {
  it("merges thousands", () => {
    const words: Word[] = [
      { text: "$8", start: 0, end: 0.3, confidence: 1 },
      { text: ",000", start: 0.3, end: 0.6, confidence: 1 },
    ];
    expect(texts(cleanWords(words))).toEqual(["$8,000"]);
  });

  it("merges millions", () => {
    const words: Word[] = [
      { text: "1", start: 0, end: 0.2, confidence: 1 },
      { text: ",000", start: 0.2, end: 0.4, confidence: 1 },
      { text: ",000", start: 0.4, end: 0.6, confidence: 1 },
    ];
    expect(texts(cleanWords(words))).toEqual(["1,000,000"]);
  });
});

describe("cleanWords — percent and currency", () => {
  it("merges percent sign", () => {
    const words: Word[] = [
      { text: "100", start: 0, end: 0.3, confidence: 1 },
      { text: "%", start: 0.3, end: 0.5, confidence: 1 },
    ];
    expect(texts(cleanWords(words))).toEqual(["100%"]);
  });

  it("merges currency prefix", () => {
    const words: Word[] = [
      { text: "$", start: 0, end: 0.1, confidence: 1 },
      { text: "2", start: 0.1, end: 0.3, confidence: 1 },
      { text: ",000", start: 0.3, end: 0.5, confidence: 1 },
    ];
    expect(texts(cleanWords(words))).toEqual(["$2,000"]);
  });
});

describe("cleanWords — contractions", () => {
  it("merges don't", () => {
    const words: Word[] = [
      { text: "don", start: 0, end: 0.2, confidence: 1 },
      { text: "'t", start: 0.2, end: 0.4, confidence: 1 },
    ];
    expect(texts(cleanWords(words))).toEqual(["don't"]);
  });

  it("merges I'm", () => {
    const words: Word[] = [
      { text: "I", start: 0, end: 0.1, confidence: 1 },
      { text: "'m", start: 0.1, end: 0.3, confidence: 1 },
    ];
    expect(texts(cleanWords(words))).toEqual(["I'm"]);
  });

  it("merges you'll", () => {
    const words: Word[] = [
      { text: "you", start: 0, end: 0.2, confidence: 1 },
      { text: "'ll", start: 0.2, end: 0.4, confidence: 1 },
    ];
    expect(texts(cleanWords(words))).toEqual(["you'll"]);
  });
});

describe("cleanWords — decimals and time", () => {
  it("merges decimal numbers", () => {
    const words: Word[] = [
      { text: "$2", start: 0, end: 0.2, confidence: 1 },
      { text: ".5", start: 0.2, end: 0.4, confidence: 1 },
    ];
    expect(texts(cleanWords(words))).toEqual(["$2.5"]);
  });

  it("merges time notation", () => {
    const words: Word[] = [
      { text: "2", start: 0, end: 0.1, confidence: 1 },
      { text: ":00", start: 0.1, end: 0.3, confidence: 1 },
    ];
    expect(texts(cleanWords(words))).toEqual(["2:00"]);
  });
});

describe("cleanWords — slash joining", () => {
  it("merges and/or", () => {
    const words: Word[] = [
      { text: "and", start: 0, end: 0.2, confidence: 1 },
      { text: "/or", start: 0.2, end: 0.4, confidence: 1 },
    ];
    expect(texts(cleanWords(words))).toEqual(["and/or"]);
  });
});

describe("cleanWords — edge cases", () => {
  it("handles empty input", () => {
    expect(cleanWords([])).toEqual([]);
  });

  it("handles single word", () => {
    const words: Word[] = [{ text: "Hello", start: 0, end: 0.5, confidence: 1 }];
    expect(texts(cleanWords(words))).toEqual(["Hello"]);
  });

  it("leaves normal words unchanged", () => {
    const words: Word[] = "Hello world how are you".split(" ").map((t, i) => ({
      text: t, start: i * 0.35, end: i * 0.35 + 0.3, confidence: 1,
    }));
    expect(texts(cleanWords(words))).toEqual(["Hello", "world", "how", "are", "you"]);
  });

  it("takes minimum confidence on merge", () => {
    const words: Word[] = [
      { text: "don", start: 0, end: 0.2, confidence: 0.9 },
      { text: "'t", start: 0.2, end: 0.4, confidence: 0.7 },
    ];
    expect(cleanWords(words)[0].confidence).toBe(0.7);
  });
});
