// Pure helpers for caption text search + find-and-replace. Kept out of the
// CaptionPanel component so the regex-escaping, case-sensitivity, and multi-line
// edge cases are unit-testable without rendering. A caption's text is treated as
// its lines joined with "\n"; matching/replacing is literal (the query is escaped,
// never interpreted as a regex) and case-insensitive unless caseSensitive is set —
// except whitespace in the query is flexible, so a phrase matches across a wrap.

import type { StyleSpan } from "../types/project";
import {
  bridgeSpansAcrossJoins,
  globalizeSpans,
  localizeSpans,
  remapSpansThroughSplices,
  renormalizeLines,
  type Splice,
} from "./spans";

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

/** Replace within a caption's joined lines, remapping its styling overlay
 *  through every replacement: spans before a match are untouched, after it
 *  shifted, partially overlapping clipped to their surviving text; a span
 *  covering the whole match keeps covering the replacement. Matches may
 *  cross the line break (the matcher is whitespace-flexible), collapsing
 *  lines — the joined-space splice plus re-localization handles that.
 *  Output is renormalized (lines trimmed, blanks dropped, spans canonical) —
 *  the same normalization handleEdit applies. A caption emptied by the
 *  replacement keeps a single empty line rather than vanishing, so a bulk
 *  replace never deletes captions or shifts indices. */
export function replaceInStyledLines(
  lines: string[],
  spans: readonly StyleSpan[],
  query: string,
  replacement: string,
  caseSensitive: boolean,
): { lines: string[]; spans: StyleSpan[] } {
  const re = buildMatcher(query, caseSensitive);
  if (!re) return { lines: [...lines], spans: [...spans] };

  const joined = lines.join("\n");
  const splices: Splice[] = [];
  for (const m of joined.matchAll(re)) {
    if (m[0].length === 0) continue;
    // Identity match: the matched text already equals the replacement (e.g.
    // case-normalizing "foo"→"FOO" over occurrences that are already "FOO").
    // Nothing changes, so no splice — the remap's clipping rules would
    // otherwise damage spans overlapping a byte-identical "edit".
    if (m[0] === replacement) continue;
    const i = m.index ?? 0;
    splices.push({ start: i, end: i + m[0].length, insertLen: replacement.length });
  }
  // Note: early return skips renormalization by design — with no actual
  // replacement this is a true no-op, not a rewrite.
  if (splices.length === 0) return { lines: [...lines], spans: [...spans] };

  const newJoined = replaceInText(joined, query, replacement, caseSensitive);
  // Bridge edge-touching same-style spans across line joins before splicing:
  // a fully-styled caption stores one span per line, so a cross-wrap match
  // would otherwise be covered by two clipped spans and the replacement
  // would lose its styling. Bridged spans re-split per line on localize, so
  // same-line replacements are unaffected.
  const bridged = bridgeSpansAcrossJoins(lines, globalizeSpans(lines, [...spans]));
  const remapped = remapSpansThroughSplices(bridged, splices);
  const newLines = newJoined.split("\n");
  const { lines: outLines, spans: outSpans } = renormalizeLines(
    newLines,
    localizeSpans(newLines, remapped),
  );
  return { lines: outLines.length ? outLines : [""], spans: outSpans };
}

/** Match ranges of `query` in `text` (joined-lines offsets), consumed as
 *  highlight decorations by StyledLines. Empty query → no ranges. */
export function matchRanges(
  text: string,
  query: string,
  caseSensitive: boolean,
): { start: number; end: number }[] {
  const re = buildMatcher(query, caseSensitive);
  if (!re) return [];
  const out: { start: number; end: number }[] = [];
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) continue;
    const i = m.index ?? 0;
    out.push({ start: i, end: i + m[0].length });
  }
  return out;
}

