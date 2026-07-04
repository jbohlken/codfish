import { describe, it, expect } from "vitest";
import {
  STYLE_ORDER,
  hashLines,
  normalizeSpans,
  spansEqual,
  segmentLine,
  globalizeSpans,
  localizeSpans,
  remapSpansThroughSplices,
  renormalizeLines,
  collapseWhitespace,
  mapRangeThroughCollapse,
  sanitizeCaptionSpans,
} from "../spans";
import type { CodProject, StyleSpan } from "../../types/project";

const em = (line: number, start: number, end: number): StyleSpan =>
  ({ line, start, end, style: "emphasis" });
const st = (line: number, start: number, end: number): StyleSpan =>
  ({ line, start, end, style: "strong" });

describe("hashLines", () => {
  it("is deterministic and depends on content", () => {
    expect(hashLines(["hello", "world"])).toBe(hashLines(["hello", "world"]));
    expect(hashLines(["hello", "world"])).not.toBe(hashLines(["hello", "world!"]));
  });

  it("distinguishes line structure from flat text", () => {
    expect(hashLines(["ab", "c"])).not.toBe(hashLines(["ab c"]));
  });

  it("hashes empty input without throwing", () => {
    expect(hashLines([])).toBeTypeOf("string");
    expect(hashLines([""])).toBe(hashLines([]));
  });
});

describe("normalizeSpans", () => {
  it("clamps offsets to the line length", () => {
    expect(normalizeSpans(["hello"], [em(0, 2, 99)])).toEqual([em(0, 2, 5)]);
  });

  it("drops spans that are empty after clamping", () => {
    expect(normalizeSpans(["hello"], [em(0, 7, 9)])).toEqual([]);
    expect(normalizeSpans(["hello"], [em(0, 3, 3)])).toEqual([]);
    expect(normalizeSpans(["hello"], [em(0, 4, 2)])).toEqual([]);
  });

  it("drops spans with unknown style keys or invalid line indices", () => {
    const bogus = { line: 0, start: 0, end: 3, style: "wiggle" } as unknown as StyleSpan;
    expect(normalizeSpans(["hello"], [bogus])).toEqual([]);
    expect(normalizeSpans(["hello"], [em(3, 0, 2)])).toEqual([]);
    expect(normalizeSpans(["hello"], [em(-1, 0, 2)])).toEqual([]);
  });

  it("sorts by line, start, then STYLE_ORDER", () => {
    const input = [st(0, 4, 6), em(0, 0, 2), em(0, 4, 6)];
    expect(normalizeSpans(["hello there"], input)).toEqual([
      em(0, 0, 2), em(0, 4, 6), st(0, 4, 6),
    ]);
  });

  it("merges overlapping and adjacent same-style spans", () => {
    expect(normalizeSpans(["hello there"], [em(0, 0, 5), em(0, 3, 8)])).toEqual([em(0, 0, 8)]);
    expect(normalizeSpans(["hello there"], [em(0, 0, 3), em(0, 3, 6)])).toEqual([em(0, 0, 6)]);
    expect(normalizeSpans(["hello there"], [em(0, 0, 8), em(0, 2, 4)])).toEqual([em(0, 0, 8)]);
  });

  it("does not merge across styles, lines, or differing values", () => {
    expect(normalizeSpans(["hello there"], [em(0, 0, 5), st(0, 3, 8)])).toHaveLength(2);
    expect(normalizeSpans(["ab", "cd"], [em(0, 0, 2), em(1, 0, 2)])).toHaveLength(2);
    const a: StyleSpan = { ...em(0, 0, 3), value: "a" };
    const b: StyleSpan = { ...em(0, 3, 6), value: "b" };
    expect(normalizeSpans(["hello there"], [a, b])).toHaveLength(2);
    const same: StyleSpan = { ...em(0, 3, 6), value: "a" };
    expect(normalizeSpans(["hello there"], [a, same])).toEqual([{ ...em(0, 0, 6), value: "a" }]);
  });

  it("snaps boundaries off surrogate pairs (start down, end up)", () => {
    // "a😀b": a=0, high=1, low=2, b=3
    const text = "a\u{1F600}b";
    expect(normalizeSpans([text], [em(0, 2, 4)])).toEqual([em(0, 1, 4)]);
    expect(normalizeSpans([text], [em(0, 0, 2)])).toEqual([em(0, 0, 3)]);
  });

  it("drops zero-length spans at a surrogate midpoint instead of inflating them", () => {
    expect(normalizeSpans(["a\u{1F600}b"], [em(0, 2, 2)])).toEqual([]);
  });

  it("drops entries with non-finite or non-integer fields without throwing", () => {
    const junk = [
      { line: 0.5, start: 0, end: 3, style: "emphasis" },
      { line: 0, start: NaN, end: 3, style: "emphasis" },
      { line: 0, start: 0, end: undefined, style: "emphasis" },
      null,
      "garbage",
    ] as unknown as StyleSpan[];
    expect(normalizeSpans(["hello"], junk)).toEqual([]);
  });

  it("is idempotent", () => {
    const once = normalizeSpans(["hello there"], [st(0, 4, 6), em(0, 0, 5), em(0, 3, 8)]);
    expect(normalizeSpans(["hello there"], once)).toEqual(once);
  });
});

describe("spansEqual", () => {
  it("compares element-wise including value", () => {
    expect(spansEqual([em(0, 0, 3)], [em(0, 0, 3)])).toBe(true);
    expect(spansEqual([em(0, 0, 3)], [em(0, 0, 4)])).toBe(false);
    expect(spansEqual([em(0, 0, 3)], [st(0, 0, 3)])).toBe(false);
    expect(spansEqual([em(0, 0, 3)], [])).toBe(false);
    expect(spansEqual([{ ...em(0, 0, 3), value: "x" }], [em(0, 0, 3)])).toBe(false);
    expect(spansEqual([], [])).toBe(true);
  });
});

describe("segmentLine", () => {
  it("returns a single unstyled segment for plain text", () => {
    expect(segmentLine("hello", [])).toEqual([{ text: "hello", styles: [], match: false }]);
  });

  it("returns nothing for an empty line", () => {
    expect(segmentLine("", [em(0, 0, 3)])).toEqual([]);
  });

  it("splits at span boundaries", () => {
    expect(segmentLine("hello world", [em(0, 0, 5)])).toEqual([
      { text: "hello", styles: [{ style: "emphasis" }], match: false },
      { text: " world", styles: [], match: false },
    ]);
  });

  it("reports overlap segments with styles in STYLE_ORDER", () => {
    const segs = segmentLine("abcdef", [st(0, 0, 4), em(0, 2, 6)]);
    expect(segs).toEqual([
      { text: "ab", styles: [{ style: "strong" }], match: false },
      { text: "cd", styles: [{ style: "emphasis" }, { style: "strong" }], match: false },
      { text: "ef", styles: [{ style: "emphasis" }], match: false },
    ]);
    expect(STYLE_ORDER.indexOf("emphasis")).toBeLessThan(STYLE_ORDER.indexOf("strong"));
  });

  it("carries span values into segment styles (future <c.class>-style keys)", () => {
    const segs = segmentLine("abcd", [{ ...em(0, 0, 4), value: "x" }]);
    expect(segs).toEqual([
      { text: "abcd", styles: [{ style: "emphasis", value: "x" }], match: false },
    ]);
    // Distinct values on the same key each contribute, ordered by value.
    const overlap = segmentLine("ab", [
      { ...em(0, 0, 2), value: "b" },
      { ...em(0, 0, 2), value: "a" },
    ]);
    expect(overlap[0].styles).toEqual([
      { style: "emphasis", value: "a" },
      { style: "emphasis", value: "b" },
    ]);
  });

  it("composes decorations without entering the style model", () => {
    const segs = segmentLine("hello world", [em(0, 0, 5)], [{ start: 6, end: 11 }]);
    expect(segs).toEqual([
      { text: "hello", styles: [{ style: "emphasis" }], match: false },
      { text: " ", styles: [], match: false },
      { text: "world", styles: [], match: true },
    ]);
  });

  it("clamps out-of-range span offsets", () => {
    expect(segmentLine("abc", [em(0, 1, 99)])).toEqual([
      { text: "a", styles: [], match: false },
      { text: "bc", styles: [{ style: "emphasis" }], match: false },
    ]);
  });
});

describe("globalizeSpans / localizeSpans", () => {
  it("round-trips per-line spans through joined coordinates", () => {
    const lines = ["ab", "cde"];
    const spans = [em(1, 1, 3)];
    const global = globalizeSpans(lines, spans);
    expect(global).toEqual([{ start: 4, end: 6, style: "emphasis" }]);
    expect(localizeSpans(lines, global)).toEqual(spans);
  });

  it("splits a cross-line global range into one span per line", () => {
    const lines = ["ab", "cde"];
    const spans = localizeSpans(lines, [{ start: 1, end: 5, style: "emphasis" }]);
    expect(spans).toEqual([em(0, 1, 2), em(1, 0, 2)]);
  });

  it("drops separator-only ranges and invalid lines on the way through", () => {
    const lines = ["ab", "cde"];
    expect(localizeSpans(lines, [{ start: 2, end: 3, style: "emphasis" }])).toEqual([]);
    expect(globalizeSpans(lines, [em(5, 0, 2)])).toEqual([]);
  });

  it("carries value through both directions", () => {
    const lines = ["abc"];
    const spans: StyleSpan[] = [{ ...em(0, 0, 2), value: "x" }];
    expect(localizeSpans(lines, globalizeSpans(lines, spans))).toEqual(spans);
  });
});

describe("remapSpansThroughSplices", () => {
  const g = (start: number, end: number) => ({ start, end, style: "emphasis" as const });

  it("leaves spans before the splice untouched and shifts spans after it", () => {
    // "hello world" — replace "hello" (0,5) with "hi"
    const out = remapSpansThroughSplices([g(0, 5), g(6, 11)], [{ start: 0, end: 5, insertLen: 2 }]);
    expect(out).toEqual([g(0, 2), g(3, 8)]);
  });

  it("keeps a span covering the whole match over the replacement", () => {
    // span exactly the match: replacement inherits the style
    const out = remapSpansThroughSplices([g(6, 11)], [{ start: 6, end: 11, insertLen: 3 }]);
    expect(out).toEqual([g(6, 9)]);
  });

  it("clips partially-overlapping spans to their surviving text", () => {
    // span ends mid-match → clipped before the replacement
    expect(remapSpansThroughSplices([g(0, 8)], [{ start: 6, end: 11, insertLen: 3 }]))
      .toEqual([g(0, 6)]);
    // span starts mid-match → starts right after the replacement
    expect(remapSpansThroughSplices([g(8, 13)], [{ start: 6, end: 11, insertLen: 3 }]))
      .toEqual([g(9, 11)]);
  });

  it("drops spans strictly inside the replaced range", () => {
    expect(remapSpansThroughSplices([g(7, 10)], [{ start: 6, end: 11, insertLen: 3 }]))
      .toEqual([]);
  });

  it("accumulates deltas across multiple splices", () => {
    // "aaa bbb ccc": aaa→x, ccc→y; span on "bbb" (4,7)
    const out = remapSpansThroughSplices(
      [g(4, 7)],
      [{ start: 0, end: 3, insertLen: 1 }, { start: 8, end: 11, insertLen: 1 }],
    );
    expect(out).toEqual([g(2, 5)]);
  });

  it("handles unsorted splice input", () => {
    const out = remapSpansThroughSplices(
      [g(4, 7)],
      [{ start: 8, end: 11, insertLen: 1 }, { start: 0, end: 3, insertLen: 1 }],
    );
    expect(out).toEqual([g(2, 5)]);
  });
});

describe("renormalizeLines", () => {
  it("shifts span offsets left by removed leading whitespace", () => {
    const { lines, spans } = renormalizeLines(["  hello  "], [em(0, 2, 7)]);
    expect(lines).toEqual(["hello"]);
    expect(spans).toEqual([em(0, 0, 5)]);
  });

  it("clamps spans that covered trailing whitespace", () => {
    const { spans } = renormalizeLines(["  hello  "], [em(0, 2, 9)]);
    expect(spans).toEqual([em(0, 0, 5)]);
  });

  it("drops blank lines and remaps span line indices", () => {
    const { lines, spans } = renormalizeLines(["", "world", "   "], [em(1, 0, 5), em(2, 0, 2)]);
    expect(lines).toEqual(["world"]);
    expect(spans).toEqual([em(0, 0, 5)]);
  });

  it("returns empty lines for all-blank input", () => {
    expect(renormalizeLines(["  ", ""], [em(0, 0, 1)])).toEqual({ lines: [], spans: [] });
  });

  it("canonicalizes the surviving spans", () => {
    const { spans } = renormalizeLines(["hello there"], [em(0, 3, 8), em(0, 0, 5)]);
    expect(spans).toEqual([em(0, 0, 8)]);
  });
});

describe("collapseWhitespace / mapRangeThroughCollapse", () => {
  it("collapses interior runs and maps char positions", () => {
    const { normalized, charMap } = collapseWhitespace("a  b");
    expect(normalized).toBe("a b");
    expect(mapRangeThroughCollapse(charMap, 0, 1)).toEqual({ start: 0, end: 1 });
    expect(mapRangeThroughCollapse(charMap, 3, 4)).toEqual({ start: 2, end: 3 });
    expect(mapRangeThroughCollapse(charMap, 0, 4)).toEqual({ start: 0, end: 3 });
  });

  it("returns null for whitespace-only ranges", () => {
    const { charMap } = collapseWhitespace("a  b");
    expect(mapRangeThroughCollapse(charMap, 1, 3)).toBeNull();
  });

  it("drops leading and trailing whitespace", () => {
    expect(collapseWhitespace("  ab  ").normalized).toBe("ab");
    const { charMap } = collapseWhitespace("  ab  ");
    expect(mapRangeThroughCollapse(charMap, 2, 4)).toEqual({ start: 0, end: 2 });
    expect(mapRangeThroughCollapse(charMap, 4, 6)).toBeNull();
  });

  it("treats newlines and tabs as collapsible whitespace", () => {
    expect(collapseWhitespace("a\n\tb").normalized).toBe("a b");
  });
});

describe("sanitizeCaptionSpans", () => {
  const makeProject = (captions: CodProject["media"][number]["captions"]): CodProject => ({
    version: 1,
    name: "t",
    transcriptionModel: "base",
    language: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    media: [{
      id: "m1", name: "clip", path: "C:/clip.mp4", fps: 24,
      captions, exports: [],
    }],
  });

  const cap = (over: Partial<CodProject["media"][number]["captions"][number]> = {}) => ({
    index: 0, start: 0, end: 2, lines: ["hello world"], ...over,
  });

  it("returns the identical object when nothing needs fixing", () => {
    const proj = makeProject([cap()]);
    expect(sanitizeCaptionSpans(proj)).toBe(proj);
    const styled = makeProject([cap({
      spans: [em(0, 0, 5)],
      spansHash: hashLines(["hello world"]),
    })]);
    expect(sanitizeCaptionSpans(styled)).toBe(styled);
  });

  it("keeps and canonicalizes spans whose hash matches", () => {
    const proj = makeProject([cap({
      spans: [em(0, 3, 8), em(0, 0, 5)],
      spansHash: hashLines(["hello world"]),
    })]);
    const out = sanitizeCaptionSpans(proj);
    expect(out.media[0].captions[0].spans).toEqual([em(0, 0, 8)]);
    expect(out.media[0].captions[0].spansHash).toBe(hashLines(["hello world"]));
  });

  it("drops spans and hash when the hash mismatches (text edited under them)", () => {
    const proj = makeProject([cap({
      spans: [em(0, 0, 5)],
      spansHash: hashLines(["different text"]),
    })]);
    const out = sanitizeCaptionSpans(proj);
    expect(out.media[0].captions[0].spans).toBeUndefined();
    expect(out.media[0].captions[0].spansHash).toBeUndefined();
  });

  it("drops spans that carry no hash at all", () => {
    const proj = makeProject([cap({ spans: [em(0, 0, 5)] })]);
    const out = sanitizeCaptionSpans(proj);
    expect(out.media[0].captions[0].spans).toBeUndefined();
  });

  it("removes empty span arrays and orphaned hashes", () => {
    const proj = makeProject([cap({ spans: [], spansHash: "deadbeef" })]);
    const out = sanitizeCaptionSpans(proj);
    expect(out.media[0].captions[0].spans).toBeUndefined();
    expect(out.media[0].captions[0].spansHash).toBeUndefined();
  });

  it("drops the fields when every span normalizes away", () => {
    const proj = makeProject([cap({
      spans: [em(0, 20, 30)],
      spansHash: hashLines(["hello world"]),
    })]);
    const out = sanitizeCaptionSpans(proj);
    expect(out.media[0].captions[0].spans).toBeUndefined();
    expect(out.media[0].captions[0].spansHash).toBeUndefined();
  });

  it("filters null span entries without aborting the load", () => {
    const proj = makeProject([cap({
      spans: [null as unknown as StyleSpan, em(0, 0, 5)],
      spansHash: hashLines(["hello world"]),
    })]);
    const out = sanitizeCaptionSpans(proj);
    expect(out.media[0].captions[0].spans).toEqual([em(0, 0, 5)]);
  });

  it("passes unknown future style keys through untouched when the hash matches", () => {
    const sparkle = { line: 0, start: 6, end: 11, style: "sparkle" } as unknown as StyleSpan;
    const proj = makeProject([cap({
      spans: [sparkle, em(0, 3, 8), em(0, 0, 5)],
      spansHash: hashLines(["hello world"]),
    })]);
    const out = sanitizeCaptionSpans(proj);
    // Known keys canonicalize (and sort first); the unknown key survives as-is.
    expect(out.media[0].captions[0].spans).toEqual([em(0, 0, 8), sparkle]);
    expect(out.media[0].captions[0].spansHash).toBe(hashLines(["hello world"]));
    // Idempotent: a second pass returns the same object.
    expect(sanitizeCaptionSpans(out)).toBe(out);
  });

  it("still drops unknown-key spans when the hash mismatches", () => {
    const sparkle = { line: 0, start: 6, end: 11, style: "sparkle" } as unknown as StyleSpan;
    const proj = makeProject([cap({ spans: [sparkle], spansHash: "beef" })]);
    const out = sanitizeCaptionSpans(proj);
    expect(out.media[0].captions[0].spans).toBeUndefined();
  });

  it("leaves untouched captions reference-equal inside a changed project", () => {
    const clean = cap();
    const dirty = cap({ index: 1, spans: [em(0, 0, 5)] });
    const proj = makeProject([clean, dirty]);
    const out = sanitizeCaptionSpans(proj);
    expect(out).not.toBe(proj);
    expect(out.media[0].captions[0]).toBe(clean);
  });
});
