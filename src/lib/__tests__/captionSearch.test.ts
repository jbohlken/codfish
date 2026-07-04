import { describe, it, expect } from "vitest";
import {
  escapeRegExp,
  captionMatches,
  replaceInText,
  replaceInStyledLines,
  matchRanges,
} from "../captionSearch";

describe("escapeRegExp", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegExp("a.b*c?")).toBe("a\\.b\\*c\\?");
    expect(escapeRegExp("(x)[y]{z}")).toBe("\\(x\\)\\[y\\]\\{z\\}");
  });
  it("leaves plain text untouched", () => {
    expect(escapeRegExp("hello world")).toBe("hello world");
  });
});

describe("captionMatches", () => {
  it("is case-insensitive by default", () => {
    expect(captionMatches("The Quick Fox", "fox", false)).toBe(true);
    expect(captionMatches("The Quick Fox", "FOX", false)).toBe(true);
  });
  it("respects case-sensitive mode", () => {
    expect(captionMatches("The Quick Fox", "fox", true)).toBe(false);
    expect(captionMatches("The Quick Fox", "Fox", true)).toBe(true);
  });
  it("matches the query literally (no regex interpretation)", () => {
    expect(captionMatches("a.b", "a.b", false)).toBe(true);
    expect(captionMatches("axb", "a.b", false)).toBe(false);
  });
  it("matches across the line join", () => {
    expect(captionMatches(["the quick", "brown fox"].join("\n"), "quick", false)).toBe(true);
  });
  it("never matches an empty query", () => {
    expect(captionMatches("anything", "", false)).toBe(false);
  });
});

describe("replaceInText", () => {
  it("replaces every occurrence", () => {
    expect(replaceInText("fox fox fox", "fox", "cat", false)).toBe("cat cat cat");
  });
  it("case-insensitive find replaces all cases with the literal replacement", () => {
    expect(replaceInText("Fox fox FOX", "fox", "cat", false)).toBe("cat cat cat");
  });
  it("case-sensitive find only replaces exact case", () => {
    expect(replaceInText("Fox fox FOX", "fox", "cat", true)).toBe("Fox cat FOX");
  });
  it("treats the query literally", () => {
    expect(replaceInText("a.b a.b", "a.b", "X", false)).toBe("X X");
    expect(replaceInText("axb", "a.b", "X", false)).toBe("axb");
  });
  it("treats the replacement literally ($ not interpreted)", () => {
    expect(replaceInText("hi", "hi", "$&!", false)).toBe("$&!");
    expect(replaceInText("hi", "hi", "a$1b", false)).toBe("a$1b");
  });
  it("returns the text unchanged for an empty query", () => {
    expect(replaceInText("hi", "", "x", false)).toBe("hi");
  });
});

const em = (line: number, start: number, end: number) =>
  ({ line, start, end, style: "emphasis" as const });

describe("replaceInStyledLines", () => {
  it("preserves line breaks and replaces within each line", () => {
    expect(replaceInStyledLines(["the fox", "fox again"], [], "fox", "cat", false).lines)
      .toEqual(["the cat", "cat again"]);
  });
  it("trims each line and drops blanks (matches handleEdit)", () => {
    expect(replaceInStyledLines(["the  fox  ", "ok"], [], "fox", "", false).lines)
      .toEqual(["the", "ok"]);
  });
  it("keeps a single empty line rather than vanishing when emptied", () => {
    expect(replaceInStyledLines(["fox"], [], "fox", "", false).lines).toEqual([""]);
  });
  it("leaves lines and spans untouched when nothing matches", () => {
    expect(replaceInStyledLines(["hello", "world"], [em(0, 0, 5)], "zzz", "x", false))
      .toEqual({ lines: ["hello", "world"], spans: [em(0, 0, 5)] });
  });

  it("shifts spans after the replacement and keeps spans before it", () => {
    // "the fox ran" — emphasis on "the" and on "ran"; replace fox → cats
    const out = replaceInStyledLines(["the fox ran"], [em(0, 0, 3), em(0, 8, 11)], "fox", "cats", false);
    expect(out.lines).toEqual(["the cats ran"]);
    expect(out.spans).toEqual([em(0, 0, 3), em(0, 9, 12)]);
  });

  it("keeps the replacement styled when the match sits inside a styled run", () => {
    // whole line emphasized; replacing a word inside keeps the run continuous
    const out = replaceInStyledLines(["the fox ran"], [em(0, 0, 11)], "fox", "cats", false);
    expect(out.lines).toEqual(["the cats ran"]);
    expect(out.spans).toEqual([em(0, 0, 12)]);
  });

  it("clips a partially-overlapped span to its surviving text", () => {
    // emphasis covers "the fo|"; the match "fox" eats its tail
    const out = replaceInStyledLines(["the fox ran"], [em(0, 0, 6)], "fox", "cats", false);
    expect(out.lines).toEqual(["the cats ran"]);
    expect(out.spans).toEqual([em(0, 0, 4)]);
  });

  it("remaps spans through a cross-line replacement that merges the lines", () => {
    // "brown fox" matches across the wrap; styling on "the" and "jumps" survives
    const out = replaceInStyledLines(
      ["the quick brown", "fox jumps"],
      [em(0, 0, 3), em(1, 4, 9)],
      "brown fox", "red cat", false,
    );
    expect(out.lines).toEqual(["the quick red cat jumps"]);
    expect(out.spans).toEqual([em(0, 0, 3), em(0, 18, 23)]);
  });

  it("keeps the replacement styled when a fully-styled caption is replaced across the wrap", () => {
    // The run is stored per line (the model can't span the break); bridging
    // makes the cross-wrap match sit inside one continuous run, so the
    // replacement inherits the styling.
    const out = replaceInStyledLines(
      ["the quick brown", "fox jumps"],
      [em(0, 0, 15), em(1, 0, 9)],
      "brown fox", "red cat", false,
    );
    expect(out.lines).toEqual(["the quick red cat jumps"]);
    expect(out.spans).toEqual([em(0, 0, 23)]);
  });

  it("handles multiple matches in one caption with cumulative shifts", () => {
    const out = replaceInStyledLines(["fox and fox"], [em(0, 4, 7)], "fox", "cat", false);
    expect(out.lines).toEqual(["cat and cat"]);
    expect(out.spans).toEqual([em(0, 4, 7)]);
  });

  it("identity matches never clip or delete overlapping spans", () => {
    // Replacement equals the matched text: a true no-op must leave spans exact.
    const partial = replaceInStyledLines(["hello world"], [em(0, 3, 8)], "world", "world", false);
    expect(partial).toEqual({ lines: ["hello world"], spans: [em(0, 3, 8)] });
    const inside = replaceInStyledLines(["hello world"], [em(0, 6, 9)], "world", "world", false);
    expect(inside).toEqual({ lines: ["hello world"], spans: [em(0, 6, 9)] });
  });

  it("case-normalization only splices the matches that actually change", () => {
    // Line 0 already reads "FOO" (identity match — span untouched); line 1
    // genuinely changes.
    const out = replaceInStyledLines(
      ["FOO here", "foo there"],
      [em(0, 0, 3)],
      "foo", "FOO", false,
    );
    expect(out.lines).toEqual(["FOO here", "FOO there"]);
    expect(out.spans).toEqual([em(0, 0, 3)]);
  });
});

describe("edge cases — matcher statefulness & multi-line queries", () => {
  it("is repeatable — a fresh matcher each call means no global-regex lastIndex leak", () => {
    // Guards the module's stated invariant: caching/hoisting the matcher would
    // make the second re.test()/matchAll() resume mid-string and silently miss.
    expect(captionMatches("fox", "fox", false)).toBe(true);
    expect(captionMatches("fox", "fox", false)).toBe(true);
    expect(matchRanges("a fox b", "fox", false)).toEqual(matchRanges("a fox b", "fox", false));
  });

  it("matches a query that spans the line join (text is joined with \\n)", () => {
    expect(captionMatches(["the fox", "brown"].join("\n"), "fox\nbrown", false)).toBe(true);
  });

  it("collapses the spanned lines when a multi-line query is replaced", () => {
    // Unreachable from the single-line search input, but pinned so the helper's
    // behaviour is explicit: replacing across the join merges the two lines.
    expect(replaceInStyledLines(["the fox", "brown"], [], "fox\nbrown", "cat", false).lines)
      .toEqual(["the cat"]);
  });

  it("reports a multi-line-query match as one range spanning the break", () => {
    expect(matchRanges(["the fox", "brown"].join("\n"), "fox\nbrown", false)).toEqual([
      { start: 4, end: 13 },
    ]);
  });
});

describe("whitespace-flexible matching (across line wraps)", () => {
  it("a space in the query matches a line break in the text", () => {
    // The phrase wraps: "brown" ends line 1, "fox" starts line 2.
    expect(captionMatches(["the quick brown", "fox jumps"].join("\n"), "brown fox", false)).toBe(true);
  });

  it("a space in the query matches a run of whitespace", () => {
    expect(captionMatches("a    b", "a b", false)).toBe(true);
    expect(replaceInText("a    b", "a b", "X", false)).toBe("X");
  });

  it("replacing a wrap-spanning phrase merges the two lines at that point", () => {
    expect(replaceInStyledLines(["the quick brown", "fox jumps"], [], "brown fox", "red cat", false).lines)
      .toEqual(["the quick red cat jumps"]);
  });

});

describe("matchRanges", () => {
  it("returns joined-text offsets for each match", () => {
    expect(matchRanges("the cat and the cat", "cat", false)).toEqual([
      { start: 4, end: 7 },
      { start: 16, end: 19 },
    ]);
  });

  it("returns nothing for an empty query", () => {
    expect(matchRanges("anything", "", false)).toEqual([]);
  });

  it("matches across a line break like the rest of the search", () => {
    expect(matchRanges(["brown", "fox"].join("\n"), "brown fox", false)).toEqual([
      { start: 0, end: 9 },
    ]);
  });

  it("respects case sensitivity", () => {
    expect(matchRanges("Cat cat", "cat", true)).toEqual([{ start: 4, end: 7 }]);
    expect(matchRanges("Cat cat", "cat", false)).toHaveLength(2);
  });

  it("reports adjacent matches as distinct ranges", () => {
    expect(matchRanges("foxfox", "fox", false)).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
    ]);
  });

  it("returns nothing for empty text or a non-matching query", () => {
    expect(matchRanges("", "x", false)).toEqual([]);
    expect(matchRanges("hello", "zzz", false)).toEqual([]);
  });
});
