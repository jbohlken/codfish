// Span math for inline caption styling. CaptionBlock.lines stays plain text;
// styling lives in an overlay of StyleSpans (per-line UTF-16 ranges with
// semantic keys). Every mutation of styled caption text flows through this
// module so offsets can never silently drift from the text they describe.
// The editor widget, the renderers, and the export emitter are all consumers
// of the same primitives.

import type { CaptionBlock, CodProject, SpanStyleKey, StyleSpan } from "../types/project";

/// Fixed nesting/emission order when multiple styles cover the same text.
/// Renderers and the export emitter both use it, so in-app display and
/// exported markup nest identically. Append new keys, never reorder.
export const STYLE_ORDER: readonly SpanStyleKey[] = ["emphasis", "strong", "underline"];

const STYLE_RANK = new Map(STYLE_ORDER.map((k, i) => [k, i]));

/** Whether this version understands the span's style key. Unknown keys come
 *  from newer app versions and are preserved-but-inert (never rendered,
 *  edited, or exported here). */
export function isKnownSpanStyle(style: string): boolean {
  return STYLE_RANK.has(style as SpanStyleKey);
}

/** Whether the caption EDITOR can round-trip this span. The editor authors
 *  plain known-key styles only — value-bearing spans (future <c.class>-type
 *  data) would lose their value through render→serialize, so they are
 *  preserved outside the edit session exactly like unknown keys: kept while
 *  the text is unchanged, dropped when it's rewritten. Split/merge/replace
 *  DO remap value-bearing known spans (values survive those pipelines). */
export function isEditorEditableSpan(s: StyleSpan): boolean {
  return isKnownSpanStyle(s.style) && s.value === undefined;
}

// ── Integrity hash ──────────────────────────────────────────────────────────

/** FNV-1a 32-bit over the joined lines, as hex. Written to CaptionBlock
 *  .spansHash whenever spans are written; a mismatch on load means the text
 *  was rewritten under the spans (e.g. by an older app version that spreads
 *  unknown caption fields through text edits) and the spans are stale. */
export function hashLines(lines: string[]): string {
  const text = lines.join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// ── Canonicalization ────────────────────────────────────────────────────────

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** True when offset i sits between the halves of a surrogate pair in text. */
function splitsPair(text: string, i: number): boolean {
  return i > 0 && i < text.length &&
    isHighSurrogate(text.charCodeAt(i - 1)) && isLowSurrogate(text.charCodeAt(i));
}

/**
 * Canonical form: offsets clamped to their line and snapped off surrogate
 * pairs (start down, end up — a boundary can never split an emoji, so the
 * emitter can't produce lone surrogates in exported files), empty and
 * unknown-style and out-of-range-line spans dropped, sorted by
 * (line, start, STYLE_ORDER, end), and same-style overlapping/adjacent spans
 * merged. Spans with differing `value` never merge.
 */
export function normalizeSpans(lines: string[], spans: readonly StyleSpan[]): StyleSpan[] {
  const cleaned: StyleSpan[] = [];
  for (const s of spans) {
    if (!s || typeof s !== "object" || !STYLE_RANK.has(s.style)) continue;
    if (!Number.isInteger(s.line) || !Number.isFinite(s.start) || !Number.isFinite(s.end)) continue;
    const text = lines[s.line];
    if (typeof text !== "string") continue;
    let start = Math.max(0, Math.min(s.start, text.length));
    let end = Math.max(0, Math.min(s.end, text.length));
    // Degenerate spans drop BEFORE snapping — a zero-length span sitting
    // mid-pair must vanish, not inflate to cover the emoji.
    if (start >= end) continue;
    if (splitsPair(text, start)) start -= 1;
    if (splitsPair(text, end)) end += 1;
    cleaned.push({ line: s.line, start, end, style: s.style, ...(s.value !== undefined ? { value: s.value } : {}) });
  }

  // Locale-independent tie-breaks: canonical order must be byte-identical
  // across machines (spansHash and export output both rely on determinism).
  const byCanonical = (a: StyleSpan, b: StyleSpan) => {
    const base =
      a.line - b.line ||
      a.start - b.start ||
      STYLE_RANK.get(a.style)! - STYLE_RANK.get(b.style)! ||
      a.end - b.end;
    if (base) return base;
    const av = a.value ?? "";
    const bv = b.value ?? "";
    return av < bv ? -1 : av > bv ? 1 : 0;
  };
  cleaned.sort(byCanonical);

  // Same-(line, style, value) spans arrive start-ordered, so tracking the
  // most recent span per key is enough to merge every overlap/adjacency.
  const merged: StyleSpan[] = [];
  const lastByKey = new Map<string, StyleSpan>();
  for (const s of cleaned) {
    const key = JSON.stringify([s.line, s.style, s.value ?? null]);
    const prev = lastByKey.get(key);
    if (prev && s.start <= prev.end) {
      prev.end = Math.max(prev.end, s.end);
    } else {
      const copy = { ...s };
      merged.push(copy);
      lastByKey.set(key, copy);
    }
  }
  // Merging can grow earlier ends; re-sort so equal inputs always produce
  // byte-identical canonical arrays.
  merged.sort(byCanonical);
  return merged;
}

/** Element-wise equality. Both sides should be in canonical (normalized)
 *  form, so ordering differences never masquerade as changes. */
export function spansEqual(a: readonly StyleSpan[], b: readonly StyleSpan[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => {
    const t = b[i];
    return s.line === t.line && s.start === t.start && s.end === t.end &&
      s.style === t.style && s.value === t.value;
  });
}

// ── Segmentation (shared by renderers and the export emitter) ───────────────

/** One active style over a segment. `value` parameterizes value-bearing
 *  keys (e.g. a future "class" key rendering VTT <c.{{value}}> tags) — it
 *  must survive the sweep so renderers and the export emitter can honor it. */
export interface SegmentStyle {
  style: SpanStyleKey;
  value?: string;
}

export interface LineSegment {
  text: string;
  /** Active styles over this segment, ordered by STYLE_ORDER (then value). */
  styles: SegmentStyle[];
  /** True when a decoration range (e.g. a search match) covers this segment. */
  match: boolean;
}

/**
 * Sweep one line into consecutive segments of uniform styling. `spans` are
 * this line's spans (line field ignored); `decorations` are ephemeral ranges
 * that never enter the model — they only flip `match`. Offsets are clamped,
 * so untrusted input can't produce out-of-range slices.
 */
export function segmentLine(
  text: string,
  spans: readonly Pick<StyleSpan, "start" | "end" | "style" | "value">[],
  decorations: readonly { start: number; end: number }[] = [],
): LineSegment[] {
  if (text.length === 0) return [];
  if (spans.length === 0 && decorations.length === 0) {
    return [{ text, styles: [], match: false }];
  }
  const bounds = new Set<number>([0, text.length]);
  for (const r of [...spans, ...decorations]) {
    bounds.add(Math.max(0, Math.min(r.start, text.length)));
    bounds.add(Math.max(0, Math.min(r.end, text.length)));
  }
  const sorted = [...bounds].sort((x, y) => x - y);

  const out: LineSegment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a >= b) continue;
    const styles: SegmentStyle[] = [];
    for (const key of STYLE_ORDER) {
      const covering = spans
        .filter((s) => s.style === key && s.start <= a && s.end >= b)
        .map((s) => s.value)
        // Same-key covers dedupe by value (overlapping same-style same-value
        // spans are one style; distinct values each contribute).
        .filter((v, idx, arr) => arr.indexOf(v) === idx)
        .sort((x, y) => (x ?? "") < (y ?? "") ? -1 : (x ?? "") > (y ?? "") ? 1 : 0);
      for (const value of covering) {
        styles.push({ style: key, ...(value !== undefined ? { value } : {}) });
      }
    }
    const match = decorations.some((d) => d.start <= a && d.end >= b);
    out.push({ text: text.slice(a, b), styles, match });
  }
  return out;
}

// ── Joined-space projection ─────────────────────────────────────────────────
//
// Cross-line operations (find/replace, reflow) work on lines joined with a
// single-character separator ("\n" or " "). These helpers move spans between
// per-line and joined coordinates.

export interface GlobalSpan {
  start: number; // inclusive, offset in lines.join(<1-char sep>)
  end: number;   // exclusive
  style: SpanStyleKey;
  value?: string;
}

function lineStartOffsets(lines: string[]): number[] {
  const starts: number[] = [];
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = acc;
    acc += lines[i].length + 1; // +1 for the separator
  }
  return starts;
}

/** Project per-line spans into joined-text offsets. Offsets are clamped to
 *  their line; empty or invalid-line spans are dropped. */
export function globalizeSpans(lines: string[], spans: readonly StyleSpan[]): GlobalSpan[] {
  const starts = lineStartOffsets(lines);
  const out: GlobalSpan[] = [];
  for (const s of spans) {
    const text = lines[s.line];
    if (typeof text !== "string") continue;
    const start = starts[s.line] + Math.max(0, Math.min(s.start, text.length));
    const end = starts[s.line] + Math.max(0, Math.min(s.end, text.length));
    if (start >= end) continue;
    out.push({ start, end, style: s.style, ...(s.value !== undefined ? { value: s.value } : {}) });
  }
  return out;
}

/** Project joined-text ranges back onto lines. A range crossing a separator
 *  yields one span per intersected line (the separator itself carries no
 *  styling). Empty intersections are dropped. */
export function localizeSpans(lines: string[], globalSpans: readonly GlobalSpan[]): StyleSpan[] {
  const starts = lineStartOffsets(lines);
  const out: StyleSpan[] = [];
  for (const g of globalSpans) {
    for (let line = 0; line < lines.length; line++) {
      const lineStart = starts[line];
      const lineEnd = lineStart + lines[line].length;
      const a = Math.max(g.start, lineStart);
      const b = Math.min(g.end, lineEnd);
      if (a >= b) continue;
      out.push({
        line,
        start: a - lineStart,
        end: b - lineStart,
        style: g.style,
        ...(g.value !== undefined ? { value: g.value } : {}),
      });
    }
  }
  return out;
}

/**
 * Bridge heuristic for reflow joins. The per-line span model can't style the
 * separator between lines, so joining two fully-styled lines would leave the
 * new space unstyled (a one-space gap in underline; `<u>a</u> <u>b</u>` in
 * exports). When a same-style, same-value pair sits edge-to-edge across a
 * join — the first ending exactly at its line's end, the second starting at
 * position 0 of the next line — the human intent is a continuous run, so the
 * pair merges across the separator. Chains across any number of fully-styled
 * lines. Operates on joined-space spans; `lines` provides the boundaries.
 *
 * Deliberately does NOT chain across an empty line (two separators in a
 * row): a blank line reads as intentional separation, not a wrapped run.
 * Blank lines only occur in hand-authored .cod files — every in-app commit
 * path drops them.
 */
export function bridgeSpansAcrossJoins(
  lines: string[],
  spans: readonly GlobalSpan[],
): GlobalSpan[] {
  // Joined-space offset of each line's end (the position of a separator).
  const lineEnds = new Set<number>();
  let acc = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    acc += lines[i].length;
    lineEnds.add(acc);
    acc += 1;
  }

  // Group per exact (style, value) key — valueless and value:"" are distinct
  // — then scan each group start-ordered. Robust to unnormalized input:
  // overlapping/adjacent same-key spans merge here too (normalizeSpans would
  // do it downstream anyway), so an interposed span can never break a chain.
  const groups = new Map<string, GlobalSpan[]>();
  for (const s of spans) {
    const key = JSON.stringify([s.style, s.value ?? null]);
    const group = groups.get(key);
    if (group) group.push(s);
    else groups.set(key, [s]);
  }

  const out: GlobalSpan[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.start - b.start || a.end - b.end);
    let cur = { ...sorted[0] };
    for (let i = 1; i < sorted.length; i++) {
      const s = sorted[i];
      const bridgesJoin = s.start === cur.end + 1 && lineEnds.has(cur.end);
      if (s.start <= cur.end || bridgesJoin) {
        cur.end = Math.max(cur.end, s.end);
      } else {
        out.push(cur);
        cur = { ...s };
      }
    }
    out.push(cur);
  }
  return out;
}

// ── Splice remapping (find/replace) ─────────────────────────────────────────

export interface Splice {
  start: number;     // inclusive, in ORIGINAL joined-text coordinates
  end: number;       // exclusive, in ORIGINAL joined-text coordinates
  insertLen: number; // length of the replacement text
}

/**
 * Remap joined-space spans through a batch of replacements (all expressed in
 * original coordinates, non-overlapping; sorted internally).
 *
 * Composition order for a span-aware replace (the localize/renormalize order
 * matters — renormalize takes per-line spans and trimming first would
 * invalidate joined offsets):
 *   globalizeSpans → remapSpansThroughSplices → split the NEW joined text on
 *   "\n" → localizeSpans(newLines, remapped) → renormalizeLines(newLines, …)
 *
 * Boundary rules, pinned by tests:
 * - a boundary before a splice is unchanged; after it, shifted by its delta;
 * - a span START strictly inside a replaced range moves to just after the
 *   replacement; a span END strictly inside moves to just before it — so
 *   partially-overlapped spans clip to their surviving text and the
 *   replacement is unstyled;
 * - a span covering the whole replaced range (boundaries at or outside the
 *   match edges) keeps covering it — replacing a word inside or exactly
 *   matching a styled run keeps the replacement styled.
 */
export function remapSpansThroughSplices(
  spans: readonly GlobalSpan[],
  splices: readonly Splice[],
): GlobalSpan[] {
  const ordered = [...splices].sort((a, b) => a.start - b.start);

  const mapPos = (p: number, isStart: boolean): number => {
    let delta = 0;
    for (const s of ordered) {
      if (p <= s.start) break;
      if (p >= s.end) {
        delta += s.insertLen - (s.end - s.start);
        continue;
      }
      // Strictly inside the replaced range.
      return isStart ? s.start + delta + s.insertLen : s.start + delta;
    }
    return p + delta;
  };

  const out: GlobalSpan[] = [];
  for (const g of spans) {
    const start = mapPos(g.start, true);
    const end = mapPos(g.end, false);
    if (start >= end) continue;
    out.push({ ...g, start, end });
  }
  return out;
}

// ── Commit-time normalization (shared by editor commit and replace) ─────────

/**
 * The line normalization every text commit applies (mirrors handleEdit and
 * replaceInStyledLines): trim each line — shifting that line's span offsets left by
 * the removed leading whitespace — and drop blank lines, remapping span line
 * indices onto the kept lines. Returns canonical spans. `lines` may come back
 * empty; callers decide what an empty caption means (delete vs keep [""]).
 */
export function renormalizeLines(
  lines: readonly string[],
  spans: readonly StyleSpan[],
): { lines: string[]; spans: StyleSpan[] } {
  const keptLines: string[] = [];
  const remap = new Map<number, { index: number; shift: number }>();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    remap.set(i, { index: keptLines.length, shift: raw.length - raw.trimStart().length });
    keptLines.push(trimmed);
  }

  const moved: StyleSpan[] = [];
  for (const s of spans) {
    const m = remap.get(s.line);
    if (!m) continue;
    moved.push({ ...s, line: m.index, start: s.start - m.shift, end: s.end - m.shift });
  }
  return { lines: keptLines, spans: normalizeSpans(keptLines, moved) };
}

// ── Whitespace-collapse mapping (split/merge reflow) ────────────────────────
//
// Reflow tokenizes on /\s+/ and re-joins with single spaces, which collapses
// interior whitespace runs — a raw offset carried across that step would
// drift. The map ties each original NON-whitespace character to its position
// in the collapsed text; span ranges snap to the characters they actually
// cover, so whitespace-only spans vanish instead of smearing.

export function collapseWhitespace(text: string): { normalized: string; charMap: Int32Array } {
  const charMap = new Int32Array(text.length).fill(-1);
  let out = "";
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    charMap[i] = out.length;
    out += text[i];
  }
  return { normalized: out, charMap };
}

/** Map an original-text range into collapsed-text coordinates: the range of
 *  the non-whitespace characters it covers, or null if it covers none. */
export function mapRangeThroughCollapse(
  charMap: Int32Array,
  start: number,
  end: number,
): { start: number; end: number } | null {
  const from = Math.max(0, start);
  const to = Math.min(end, charMap.length);
  let s = -1;
  for (let i = from; i < to; i++) {
    if (charMap[i] >= 0) { s = charMap[i]; break; }
  }
  if (s < 0) return null;
  let e = -1;
  for (let i = to - 1; i >= from; i--) {
    if (charMap[i] >= 0) { e = charMap[i] + 1; break; }
  }
  return { start: s, end: e };
}

// ── Load-time sanitization ──────────────────────────────────────────────────

/**
 * Validate every caption's styling overlay against its text. Spans are
 * honored only when spansHash matches hashLines(lines) — a mismatch (or a
 * missing hash) means the text was rewritten under the spans, so both fields
 * are dropped. Matching spans are canonicalized; spans whose style key this
 * version doesn't know (written by a newer app) pass through untouched so a
 * round-trip never deletes them. Runs on BOTH project ingestion paths
 * (normal load and crash-recovery restore). Returns the same object when
 * nothing changed, so an untouched load stays identity-equal.
 */
export function sanitizeCaptionSpans(proj: CodProject): CodProject {
  let projChanged = false;
  const media = proj.media.map((m) => {
    let mediaChanged = false;
    const captions = m.captions.map((c): CaptionBlock => {
      // JSON is untrusted: entries can be null or non-objects. Filter before
      // touching them so a corrupt overlay degrades instead of aborting load.
      const rawSpans = Array.isArray(c.spans)
        ? c.spans.filter((s): s is StyleSpan => !!s && typeof s === "object")
        : [];
      if (rawSpans.length === 0) {
        if (c.spans === undefined && c.spansHash === undefined) return c;
        mediaChanged = true;
        const { spans: _s, spansHash: _h, ...rest } = c;
        return rest;
      }
      if (c.spansHash !== hashLines(c.lines)) {
        mediaChanged = true;
        const { spans: _s, spansHash: _h, ...rest } = c;
        return rest;
      }
      // Unknown style keys come from a NEWER app version (STYLE_ORDER grows
      // by appending). The matching hash proves the text hasn't moved under
      // them, so carry them through untouched — this version renders and
      // exports nothing for them, but a round-trip must not delete them.
      const known = rawSpans.filter((s) => STYLE_RANK.has(s.style));
      const unknown = rawSpans.filter((s) => !STYLE_RANK.has(s.style));
      const next = [...normalizeSpans(c.lines, known), ...unknown];
      if (next.length === 0) {
        mediaChanged = true;
        const { spans: _s, spansHash: _h, ...rest } = c;
        return rest;
      }
      if (rawSpans.length === c.spans!.length && spansEqual(next, c.spans!)) return c;
      mediaChanged = true;
      return { ...c, spans: next };
    });
    if (!mediaChanged) return m;
    projChanged = true;
    return { ...m, captions };
  });
  return projChanged ? { ...proj, media } : proj;
}
