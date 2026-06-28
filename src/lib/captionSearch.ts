// Pure helpers for caption text search + find-and-replace. Kept out of the
// CaptionPanel component so the regex-escaping, case-sensitivity, and multi-line
// edge cases are unit-testable without rendering. A caption's text is treated as
// its lines joined with "\n"; matching/replacing is literal (the query is escaped,
// never interpreted as a regex) and case-insensitive unless caseSensitive is set —
// except whitespace in the query is flexible, so a phrase matches across a wrap.

/** Escape a user string so it is matched literally inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A fresh global matcher for `query`. The query is escaped (matched literally),
 *  except that any run of whitespace matches any run of whitespace in the text —
 *  including a line break — so a phrase still matches when it wraps across a
 *  caption's two lines (text is joined with "\n"). Case-insensitive unless
 *  caseSensitive. Returns null for an empty query. Fresh each call so the stateful
 *  `lastIndex` of a global RegExp never leaks between callers. */
export function buildMatcher(query: string, caseSensitive: boolean): RegExp | null {
  if (!query) return null;
  const pattern = escapeRegExp(query).replace(/\s+/g, "\\s+");
  return new RegExp(pattern, caseSensitive ? "g" : "gi");
}

/** Does `text` contain `query`? Empty query never matches. */
export function captionMatches(text: string, query: string, caseSensitive: boolean): boolean {
  const re = buildMatcher(query, caseSensitive);
  return re ? re.test(text) : false;
}

/** Replace every occurrence of `query` in `text` with `replacement`, literally —
 *  `$` in the replacement is escaped so `$1` / `$&` aren't interpreted. */
export function replaceInText(text: string, query: string, replacement: string, caseSensitive: boolean): string {
  const re = buildMatcher(query, caseSensitive);
  if (!re) return text;
  const literal = replacement.replace(/\$/g, "$$$$");
  return text.replace(re, literal);
}

/** Replace within a caption's joined lines, returning rebuilt lines (each trimmed,
 *  blank lines dropped) — the same normalization handleEdit applies. A caption
 *  emptied by the replacement keeps a single empty line rather than vanishing, so
 *  a bulk replace never deletes captions or shifts indices. */
export function replaceInLines(lines: string[], query: string, replacement: string, caseSensitive: boolean): string[] {
  const replaced = replaceInText(lines.join("\n"), query, replacement, caseSensitive);
  const out = replaced.split("\n").map((l) => l.trim()).filter(Boolean);
  return out.length ? out : [""];
}

export interface Segment {
  text: string;
  isMatch: boolean;
}

/** Split `text` into consecutive matched / unmatched segments, for highlighting.
 *  An empty query yields the whole text as one unmatched segment. */
export function splitOnMatches(text: string, query: string, caseSensitive: boolean): Segment[] {
  const re = buildMatcher(query, caseSensitive);
  if (!re) return text ? [{ text, isMatch: false }] : [];
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i), isMatch: false });
    out.push({ text: m[0], isMatch: true });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), isMatch: false });
  return out;
}
