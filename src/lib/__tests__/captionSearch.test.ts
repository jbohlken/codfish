import { describe, it, expect } from "vitest";
import {
  escapeRegExp,
  captionMatches,
  replaceInText,
  replaceInLines,
  splitOnMatches,
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

describe("replaceInLines", () => {
  it("preserves line breaks and replaces within each line", () => {
    expect(replaceInLines(["the fox", "fox again"], "fox", "cat", false)).toEqual(["the cat", "cat again"]);
  });
  it("trims each line and drops blanks (matches handleEdit)", () => {
    expect(replaceInLines(["the  fox  ", "ok"], "fox", "", false)).toEqual(["the", "ok"]);
  });
  it("keeps a single empty line rather than vanishing when emptied", () => {
    expect(replaceInLines(["fox"], "fox", "", false)).toEqual([""]);
  });
  it("leaves lines untouched when nothing matches", () => {
    expect(replaceInLines(["hello", "world"], "zzz", "x", false)).toEqual(["hello", "world"]);
  });
});

describe("splitOnMatches", () => {
  it("splits into matched and unmatched segments", () => {
    expect(splitOnMatches("the fox ran", "fox", false)).toEqual([
      { text: "the ", isMatch: false },
      { text: "fox", isMatch: true },
      { text: " ran", isMatch: false },
    ]);
  });
  it("handles a match at the very start and end", () => {
    expect(splitOnMatches("foxfox", "fox", false)).toEqual([
      { text: "fox", isMatch: true },
      { text: "fox", isMatch: true },
    ]);
  });
  it("preserves the matched substring's original case", () => {
    expect(splitOnMatches("a Fox b", "fox", false)).toEqual([
      { text: "a ", isMatch: false },
      { text: "Fox", isMatch: true },
      { text: " b", isMatch: false },
    ]);
  });
  it("returns the whole text as one segment when nothing matches", () => {
    expect(splitOnMatches("hello", "zzz", false)).toEqual([{ text: "hello", isMatch: false }]);
  });
  it("returns the whole text as one unmatched segment for an empty query", () => {
    expect(splitOnMatches("hello", "", false)).toEqual([{ text: "hello", isMatch: false }]);
  });
  it("returns nothing for empty text", () => {
    expect(splitOnMatches("", "x", false)).toEqual([]);
  });
});

describe("edge cases — matcher statefulness & multi-line queries", () => {
  it("is repeatable — a fresh matcher each call means no global-regex lastIndex leak", () => {
    // Guards the module's stated invariant: caching/hoisting the matcher would
    // make the second re.test()/matchAll() resume mid-string and silently miss.
    expect(captionMatches("fox", "fox", false)).toBe(true);
    expect(captionMatches("fox", "fox", false)).toBe(true);
    expect(splitOnMatches("a fox b", "fox", false)).toEqual(splitOnMatches("a fox b", "fox", false));
  });

  it("matches a query that spans the line join (text is joined with \\n)", () => {
    expect(captionMatches(["the fox", "brown"].join("\n"), "fox\nbrown", false)).toBe(true);
  });

  it("collapses the spanned lines when a multi-line query is replaced", () => {
    // Unreachable from the single-line search input, but pinned so the helper's
    // behaviour is explicit: replacing across the join merges the two lines.
    expect(replaceInLines(["the fox", "brown"], "fox\nbrown", "cat", false)).toEqual(["the cat"]);
  });

  it("splits a multi-line-query match into a segment spanning the break", () => {
    expect(splitOnMatches(["the fox", "brown"].join("\n"), "fox\nbrown", false)).toEqual([
      { text: "the ", isMatch: false },
      { text: "fox\nbrown", isMatch: true },
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
    expect(replaceInLines(["the quick brown", "fox jumps"], "brown fox", "red cat", false))
      .toEqual(["the quick red cat jumps"]);
  });

  it("highlights a match that spans the line break", () => {
    expect(splitOnMatches(["brown", "fox"].join("\n"), "brown fox", false)).toEqual([
      { text: "brown\nfox", isMatch: true },
    ]);
  });
});
