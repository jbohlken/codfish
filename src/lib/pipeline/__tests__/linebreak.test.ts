import { describe, it, expect } from "vitest";
import { breakIntoLines, formatPhraseToCaptionLines, breakTextIntoLines, breakStyledTextIntoLines, splitStyledTextAtToken } from "../linebreak";
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

describe("breakStyledTextIntoLines", () => {
  const em = (line: number, start: number, end: number) =>
    ({ line, start, end, style: "emphasis" as const });

  it("passes through short text with its spans unchanged", () => {
    const out = breakStyledTextIntoLines(["Hello world"], [em(0, 0, 5)]);
    expect(out.lines).toEqual(["Hello world"]);
    expect(out.spans).toEqual([em(0, 0, 5)]);
  });

  it("wraps unstyled captions exactly like breakTextIntoLines", () => {
    const text = "A very long sentence that keeps going and going";
    const out = breakStyledTextIntoLines([text], [], 25, 2);
    expect(out.lines).toEqual(breakTextIntoLines(text, 25, 2));
    expect(out.spans).toEqual([]);
  });

  it("splits a span that straddles a new line break", () => {
    // Breaks after the comma: ["one two,", "three four"]
    const out = breakStyledTextIntoLines(["one two, three four"], [em(0, 4, 14)], 10, 2);
    expect(out.lines).toEqual(["one two,", "three four"]);
    expect(out.spans).toEqual([em(0, 4, 8), em(1, 0, 5)]);
  });

  it("bridges fully-styled adjacent lines into one continuous run on join", () => {
    // Both lines entirely emphasized → the join space belongs to the run
    // (no one-space underline gap, single <i>…</i> on export).
    const out = breakStyledTextIntoLines(["Hello", "world"], [em(0, 0, 5), em(1, 0, 5)]);
    expect(out.lines).toEqual(["Hello world"]);
    expect(out.spans).toEqual([em(0, 0, 11)]);
  });

  it("does not bridge when a span misses the line edge", () => {
    // Line 1's span starts at 1, not 0 — the gap is real, keep two runs.
    const out = breakStyledTextIntoLines(["Hello", "world"], [em(0, 0, 5), em(1, 1, 5)]);
    expect(out.lines).toEqual(["Hello world"]);
    expect(out.spans).toEqual([em(0, 0, 5), em(0, 7, 11)]);
  });

  it("does not bridge across differing styles or values", () => {
    const st = (line: number, start: number, end: number) =>
      ({ line, start, end, style: "strong" as const });
    const styles = breakStyledTextIntoLines(["Hello", "world"], [em(0, 0, 5), st(1, 0, 5)]);
    expect(styles.spans).toEqual([em(0, 0, 5), st(0, 6, 11)]);
    const values = breakStyledTextIntoLines(
      ["Hello", "world"],
      [{ ...em(0, 0, 5), value: "a" }, { ...em(1, 0, 5), value: "b" }],
    );
    expect(values.spans).toEqual([
      { ...em(0, 0, 5), value: "a" },
      { ...em(0, 6, 11), value: "b" },
    ]);
  });

  it("chains the bridge across three fully-styled lines", () => {
    const out = breakStyledTextIntoLines(["a", "b", "c"], [em(0, 0, 1), em(1, 0, 1), em(2, 0, 1)]);
    expect(out.lines).toEqual(["a b c"]);
    expect(out.spans).toEqual([em(0, 0, 5)]);
  });

  it("maps offsets through interior whitespace collapse", () => {
    const out = breakStyledTextIntoLines(["one  two"], [em(0, 5, 8)]);
    expect(out.lines).toEqual(["one two"]);
    expect(out.spans).toEqual([em(0, 4, 7)]);
  });

  it("drops whitespace-only spans instead of smearing them", () => {
    const out = breakStyledTextIntoLines(["one  two"], [em(0, 3, 5)]);
    expect(out.lines).toEqual(["one two"]);
    expect(out.spans).toEqual([]);
  });

  it("carries the value field through the reflow", () => {
    const out = breakStyledTextIntoLines(["Hello world"], [{ ...em(0, 0, 5), value: "x" }]);
    expect(out.spans).toEqual([{ ...em(0, 0, 5), value: "x" }]);
  });

  it("clamps spans whose offsets exceed the line length", () => {
    const out = breakStyledTextIntoLines(["Hello"], [em(0, 2, 99)]);
    expect(out.lines).toEqual(["Hello"]);
    expect(out.spans).toEqual([em(0, 2, 5)]);
  });

  it("returns a single empty line for empty input", () => {
    const out = breakStyledTextIntoLines([""], []);
    expect(out.lines).toEqual([""]);
    expect(out.spans).toEqual([]);
  });
});

describe("splitStyledTextAtToken", () => {
  const em = (line: number, start: number, end: number) =>
    ({ line, start, end, style: "emphasis" as const });

  it("partitions text and spans at the token boundary", () => {
    // em covers "two three" [4,13) in "one two three four"; split after token 2
    const { a, b } = splitStyledTextAtToken(["one two three four"], [em(0, 4, 13)], 2);
    expect(a).toEqual({ lines: ["one two"], spans: [em(0, 4, 7)] });
    expect(b).toEqual({ lines: ["three four"], spans: [em(0, 0, 5)] });
  });

  it("keeps a span wholly inside one half untouched in the other", () => {
    const { a, b } = splitStyledTextAtToken(["one two three"], [em(0, 0, 3)], 1);
    expect(a).toEqual({ lines: ["one"], spans: [em(0, 0, 3)] });
    expect(b).toEqual({ lines: ["two three"], spans: [] });
  });

  it("maps spans through interior whitespace collapse", () => {
    // raw "one  two": em on "two" at raw offsets [5,8)
    const { a, b } = splitStyledTextAtToken(["one  two"], [em(0, 5, 8)], 1);
    expect(a).toEqual({ lines: ["one"], spans: [] });
    expect(b).toEqual({ lines: ["two"], spans: [em(0, 0, 3)] });
  });

  it("splits multi-line captions through joined-token space", () => {
    // lines ["one two","three"] → tokens one,two,three; em spans line 1 fully
    const { a, b } = splitStyledTextAtToken(["one two", "three"], [em(1, 0, 5)], 2);
    expect(a).toEqual({ lines: ["one two"], spans: [] });
    expect(b).toEqual({ lines: ["three"], spans: [em(0, 0, 5)] });
  });

  it("carries value through the partition", () => {
    const { a, b } = splitStyledTextAtToken(["one two"], [{ ...em(0, 0, 7), value: "x" }], 1);
    expect(a.spans).toEqual([{ ...em(0, 0, 3), value: "x" }]);
    expect(b.spans).toEqual([{ ...em(0, 0, 3), value: "x" }]);
  });
});

describe("splitStyledTextAtToken — bridging across original joins", () => {
  const em = (line: number, start: number, end: number) =>
    ({ line, start, end, style: "emphasis" as const });

  it("keeps a fully-styled two-line caption continuous within each half", () => {
    // Both original lines fully emphasized; the split lands mid-caption so
    // half A contains the former line join — the run must stay continuous.
    const { a, b } = splitStyledTextAtToken(
      ["hello world", "foo bar"],
      [em(0, 0, 11), em(1, 0, 7)],
      3,
    );
    expect(a).toEqual({ lines: ["hello world foo"], spans: [em(0, 0, 15)] });
    expect(b).toEqual({ lines: ["bar"], spans: [em(0, 0, 3)] });
  });

  it("still leaves a real gap unbridged through the split", () => {
    // Line 1's span starts at 1 — not edge-touching, so no bridge.
    const { a } = splitStyledTextAtToken(
      ["hello world", "foo bar"],
      [em(0, 0, 11), em(1, 1, 7)],
      4,
    );
    expect(a.lines).toEqual(["hello world foo bar"]);
    expect(a.spans).toEqual([em(0, 0, 11), em(0, 13, 19)]);
  });
});
