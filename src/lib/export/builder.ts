/**
 * Export format template interpreter.
 *
 * Parses `.cff` (Codfish Format) files and executes templates against caption
 * data. No code generation, no `new Function()` — the app interprets templates
 * directly using token substitution and `{{each}}` iteration.
 */

import type { SerializedCaption } from "./index";
import { timeComponents, formatSmpte } from "../time";
export { formatSmpte } from "../time";

// ── Public config type ──────────────────────────────────────────────────────

export interface FormatConfig {
  name: string;
  extension: string;
  template: string;
}

// ── Token definitions ───────────────────────────────────────────────────────

export interface TokenDef {
  token: string;
  description: string;
  /** Optional display string for the autocomplete popup (overrides `token` visually only). */
  display?: string;
  /** True for tokens that need a caption context (only meaningful inside `{{each}}`). */
  perCaption?: boolean;
  /** True to omit from the autocomplete popup while keeping the token valid in templates. */
  hidden?: boolean;
}

export interface TokenGroup {
  group: string;
  tokens: TokenDef[];
}

export const TOKEN_GROUPS: TokenGroup[] = [
  {
    group: "Caption",
    tokens: [
      { token: "{{index}}", description: "0-based. {{index:N}} for N-based, {{index:N:W}} to pad to W digits", perCaption: true },
      { token: "{{index:1}}", description: "1-based (offset by 1)", perCaption: true },
      { token: "{{text}}", description: "All lines joined with newlines", perCaption: true },
      { token: "{{text:space}}", description: "All lines joined with spaces", perCaption: true },
    ],
  },
  {
    group: "Timing",
    tokens: [
      { token: "{{start}}", description: "Start time as raw seconds", perCaption: true },
      { token: "{{start:HH:mm:ss.SSS}}", description: "00:00:01.200", perCaption: true },
      { token: "{{start:HH:mm:ss,SSS}}", description: "00:00:01,200", perCaption: true },
      { token: "{{start:HH:mm:ss}}", description: "00:00:01", perCaption: true },
      { token: "{{start:X.SSS}}", description: "1.200", perCaption: true },
      { token: "{{end}}", description: "End time as raw seconds", perCaption: true },
      { token: "{{end:HH:mm:ss.SSS}}", description: "00:00:03.500", perCaption: true },
      { token: "{{end:HH:mm:ss,SSS}}", description: "00:00:03,500", perCaption: true },
      { token: "{{end:HH:mm:ss}}", description: "00:00:03", perCaption: true },
      { token: "{{end:X.SSS}}", description: "3.500", perCaption: true },
      { token: "{{duration}}", description: "Duration as raw seconds (end − start)", perCaption: true },
      { token: "{{duration:HH:mm:ss.SSS}}", description: "00:00:02.300", perCaption: true },
      { token: "{{duration:HH:mm:ss,SSS}}", description: "00:00:02,300", perCaption: true },
      { token: "{{duration:HH:mm:ss}}", description: "00:00:02", perCaption: true },
      { token: "{{duration:X.SSS}}", description: "2.300", perCaption: true },
    ],
  },
  {
    group: "SMPTE",
    tokens: [
      { token: "{{start-smpte}}", description: "SMPTE timecode — DF or NDF per media setting", perCaption: true },
      { token: "{{end-smpte}}", description: "SMPTE timecode — DF or NDF per media setting", perCaption: true },
    ],
  },
  {
    group: "Global",
    tokens: [
      { token: "{{count}}", description: "Total number of captions" },
      { token: "{{json}}", description: "All captions as formatted JSON" },
    ],
  },
  {
    group: "Block",
    tokens: [
      { token: "{{each}}", display: "{{each}}...{{/each}}", description: "Iterate over captions; auto-pairs with {{/each}}" },
      { token: "{{/each}}", description: "End per-caption iteration block", hidden: true },
    ],
  },
];

/** Flat list of all tokens. Single source of truth for validation and autocomplete. */
export const TOKENS: TokenDef[] = TOKEN_GROUPS.flatMap((g) => g.tokens);

// ── Sample captions for live preview ────────────────────────────────────────

export const SAMPLE_CAPTIONS: SerializedCaption[] = [
  { index: 0, start: 1.2, end: 3.5, lines: ["Hello world"] },
  { index: 1, start: 3.8, end: 5.1, lines: ["From the builder"] },
  { index: 2, start: 6.0, end: 8.75, lines: ["Line one", "Line two"] },
];

/** Preview fps for SMPTE tokens. 29.97 so DF preview is meaningful. */
export const SAMPLE_FPS = 29.97;

// ── Template interpreter ────────────────────────────────────────────────────

/**
 * Scan a template for top-level `{{each}}...{{/each}}` blocks in document
 * order. Nested blocks aren't supported — the inner `{{each}}` is treated as
 * literal content of the outer block. Unclosed or stray directives are
 * skipped (validateTemplate surfaces them as warnings).
 */
export function findEachBlocks(template: string): Array<{ open: number; close: number }> {
  const blocks: Array<{ open: number; close: number }> = [];
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf("{{each}}", cursor);
    if (open === -1) break;
    const close = template.indexOf("{{/each}}", open + "{{each}}".length);
    if (close === -1) break;
    blocks.push({ open, close });
    cursor = close + "{{/each}}".length;
  }
  return blocks;
}

/**
 * Find offsets of `{{each}}` / `{{/each}}` directives that don't belong to a
 * valid top-level block — i.e., unclosed openers, stray closers, or nested
 * openers. The highlighter uses this to flag broken iteration structure.
 */
export function findInvalidEachOffsets(template: string): Set<number> {
  const valid = new Set<number>();
  for (const b of findEachBlocks(template)) {
    valid.add(b.open);
    valid.add(b.close);
  }
  const bad = new Set<number>();
  for (const m of template.matchAll(/\{\{\/?each\}\}/g)) {
    const offset = m.index ?? 0;
    if (!valid.has(offset)) bad.add(offset);
  }
  return bad;
}

/** Execute a template against caption data. */
export function executeTemplate(template: string, captions: SerializedCaption[], fps = SAMPLE_FPS, dropFrame = false): string {
  // Normalize line endings
  const t = template.replace(/\r\n/g, "\n");
  const blocks = findEachBlocks(t);

  if (blocks.length === 0) {
    return resolveTokens(t, null, 0, captions.length, captions, fps, dropFrame);
  }

  let result = "";
  let cursor = 0;
  for (const { open, close } of blocks) {
    // Segment before this block — global context
    result += resolveTokens(t.substring(cursor, open), null, 0, captions.length, captions, fps, dropFrame);

    // Block body — strip the leading newline right after `{{each}}`
    let body = t.substring(open + "{{each}}".length, close);
    if (body.startsWith("\n")) body = body.substring(1);
    for (let i = 0; i < captions.length; i++) {
      result += resolveTokens(body, captions[i], i, captions.length, captions, fps, dropFrame);
    }

    cursor = close + "{{/each}}".length;
  }
  // Trailing segment after the last block
  result += resolveTokens(t.substring(cursor), null, 0, captions.length, captions, fps, dropFrame);
  return result;
}

/** Preview a format config against sample data. */
export function previewTemplate(config: FormatConfig): string {
  try {
    return executeTemplate(config.template, SAMPLE_CAPTIONS, SAMPLE_FPS, true);
  } catch (e) {
    return `Error: ${e}`;
  }
}

// ── Token resolution ────────────────────────────────────────────────────────

/** Replace all {{...}} tokens in a string. */
function resolveTokens(
  text: string,
  caption: SerializedCaption | null,
  index: number,
  total: number,
  allCaptions: SerializedCaption[],
  fps: number,
  dropFrame: boolean,
): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    return resolveToken(key, caption, index, total, allCaptions, fps, dropFrame);
  });
}

/** Resolve a single token key to its string value. */
function resolveToken(
  key: string,
  caption: SerializedCaption | null,
  index: number,
  total: number,
  allCaptions: SerializedCaption[],
  fps: number,
  dropFrame: boolean,
): string {
  // ── Global tokens (work everywhere) ───────────────────────────────
  if (key === "count") return String(total);
  if (key === "json") return JSON.stringify(allCaptions, null, 2);

  // ── Per-caption tokens (need a caption context) ───────────────────
  if (!caption) return "";

  // index with optional start offset and width
  if (key === "index" || key.startsWith("index:")) {
    const parts = key.split(":");
    const offset = parts.length === 1 ? 0 : parseInt(parts[1], 10);
    const width = parts.length >= 3 ? parseInt(parts[2], 10) : 0;
    if (!isNaN(offset)) {
      const val = index + offset;
      return width >= 2 ? String(val).padStart(width, "0") : String(val);
    }
  }

  // Raw time
  if (key === "start") return String(caption.start);
  if (key === "end") return String(caption.end);
  if (key === "duration") return String(caption.end - caption.start);

  // Formatted time: start:FORMAT, end:FORMAT, duration:FORMAT
  const timeMatch = key.match(/^(start|end|duration):(.+)$/);
  if (timeMatch) {
    const [, field, fmt] = timeMatch;
    const val = field === "duration" ? (caption.end - caption.start) : caption[field as "start" | "end"];
    return formatTime(val, fmt);
  }

  // SMPTE timecode
  const smpteMatch = key.match(/^(start|end)-smpte$/);
  if (smpteMatch) {
    const field = smpteMatch[1] as "start" | "end";
    return formatSmpte(caption[field], fps, dropFrame);
  }

  // Text
  if (key === "text") return caption.lines.join("\n");
  if (key === "text:space") return caption.lines.join(" ");

  // Unknown — pass through literally
  return `{{${key}}}`;
}

// ── Time formatting ─────────────────────────────────────────────────────────

/** Allowed literal characters in time format strings. */
const FMT_LITERALS = new Set([":", ".", ",", "-", "/", " "]);

/**
 * Format a time value using moment.js-style components.
 * Components: HH/H (hours), mm/m (minutes), ss/s (seconds), SSS/SS/S (fractional), X (total sec)
 * All values truncate (floor), no rounding. Non-component characters pass through as literals.
 */
export function formatTime(t: number, fmt: string): string {
  const { h, m: mn, s: sc, frac: fr } = timeComponents(t);

  let out = "";
  let i = 0;
  while (i < fmt.length) {
    const c2 = fmt.substring(i, i + 2);
    // Count consecutive S's for fractional precision (S=tenths, SS=hundredths, SSS=millis, etc.)
    if (fmt.charAt(i) === "S") {
      let n = 0;
      while (i + n < fmt.length && fmt.charAt(i + n) === "S") n++;
      // Sub-ULP epsilon absorbs the same drift guarded elsewhere — frac comes
      // from nanosecond-snapped timeComponents, but e.g. 0.1 * 1000 in doubles
      // is 99.99999999999999 and would floor to 99. 1e-6 is far below any
      // realistic fractional tick (smallest legitimate n=9 gives 1ns per tick).
      out += String(Math.floor(fr * 10 ** n + 1e-6)).padStart(n, "0"); i += n;
    } else if (c2 === "HH") {
      out += String(h).padStart(2, "0"); i += 2;
    } else if (c2 === "mm") {
      out += String(mn).padStart(2, "0"); i += 2;
    } else if (c2 === "ss") {
      out += String(sc).padStart(2, "0"); i += 2;
    } else if (fmt.charAt(i) === "X") {
      // Same sub-ULP epsilon as the SSS branch — a drifted t = 1 - ε would
      // otherwise render as "0" instead of "1". 1e-6 s is well below any
      // legitimate second boundary we'd truncate at.
      out += String(Math.floor(t + 1e-6)); i += 1;
    } else if (fmt.charAt(i) === "H") {
      out += String(h); i += 1;
    } else if (fmt.charAt(i) === "m") {
      out += String(mn); i += 1;
    } else if (fmt.charAt(i) === "s") {
      out += String(sc); i += 1;
    } else {
      out += fmt.charAt(i); i += 1;
    }
  }
  return out;
}

// ── Token validation ────────────────────────────────────────────────────────

/** Strip the surrounding `{{ }}` from a token to get its key. */
const tokenKey = (token: string) => token.slice(2, -2);

const VALID_TOKEN_KEYS = new Set(TOKENS.map((t) => tokenKey(t.token)));

/** Check whether a token key is recognized. */
export function isValidToken(key: string): boolean {
  return VALID_TOKEN_KEYS.has(key) || isValidDynamicToken(key);
}

/** Find unrecognized {{...}} tokens in a template string. */
export function findInvalidTokens(template: string): string[] {
  const invalid: string[] = [];
  for (const match of template.matchAll(/\{\{([^}]+)\}\}/g)) {
    const key = match[1];
    if (!isValidToken(key)) {
      invalid.push(`{{${key}}}`);
    }
  }
  return invalid;
}

/** Per-caption token keys (only meaningful inside {{each}}). */
const PER_CAPTION_KEYS = new Set(
  TOKENS.filter((t) => t.perCaption).map((t) => tokenKey(t.token)),
);

export function isPerCaptionToken(key: string): boolean {
  if (PER_CAPTION_KEYS.has(key)) return true;
  // Catch user-supplied parameter values that aren't in the preset catalog.
  if (key.startsWith("index:")) return true;
  if (/^(?:start|end|duration):/.test(key)) return true;
  return false;
}

export interface TemplateWarning {
  message: string;
}

/** Validate template structure and return warnings. */
export function validateTemplate(template: string): TemplateWarning[] {
  const warnings: TemplateWarning[] = [];
  const t = template.replace(/\r\n/g, "\n");

  // Walk each / /each directives tracking depth: catches stray closes,
  // unclosed opens, and nested blocks (which the interpreter can't handle).
  let depth = 0;
  let nestedReported = false;
  let strayCloseReported = false;
  for (const m of t.matchAll(/\{\{(\/?each)\}\}/g)) {
    if (m[1] === "each") {
      depth++;
      if (depth > 1 && !nestedReported) {
        warnings.push({ message: "Nested {{each}} blocks aren't supported." });
        nestedReported = true;
      }
    } else {
      depth--;
      if (depth < 0 && !strayCloseReported) {
        warnings.push({ message: "{{/each}} without a matching {{each}}." });
        strayCloseReported = true;
        depth = 0; // recover so a later opener doesn't get double-counted
      }
    }
  }
  if (depth > 0) {
    warnings.push({ message: "{{each}} without a matching {{/each}}." });
  }

  // Per-caption tokens used outside any {{each}} block.
  const blocks = findEachBlocks(t);
  for (const match of t.matchAll(/\{\{([^}]+)\}\}/g)) {
    const key = match[1];
    const offset = match.index ?? 0;
    const inside = blocks.some((b) => offset > b.open && offset < b.close);
    if (!inside && isValidToken(key) && isPerCaptionToken(key)) {
      warnings.push({ message: `{{${key}}} is a per-caption token and won't work outside {{each}}.` });
      break; // one warning is enough
    }
  }

  // Invalid tokens
  const invalid = findInvalidTokens(template);
  for (const tok of invalid) {
    warnings.push({ message: `Unrecognized token: ${tok}` });
  }

  return warnings;
}

/** Check if a key matches a parameterized token pattern. */
function isValidDynamicToken(key: string): boolean {
  // {{index:N}} or {{index:N:W}}
  const indexMatch = key.match(/^index:(-?\d+)(?::(\d+))?$/);
  if (indexMatch) {
    if (indexMatch[2] !== undefined) {
      const width = parseInt(indexMatch[2], 10);
      return width >= 1;
    }
    return true;
  }
  // {{start:FORMAT}}, {{end:FORMAT}}, {{duration:FORMAT}}
  const timeMatch = key.match(/^(?:start|end|duration):(.+)$/);
  if (timeMatch) {
    return isValidTimeFormat(timeMatch[1]);
  }
  return false;
}

/** Validate a time format string. */
function isValidTimeFormat(fmt: string): boolean {
  // Strip recognized components (longest first), then check remaining chars
  const stripped = fmt
    .replace(/S+/g, "")
    .replace(/HH/g, "")
    .replace(/mm/g, "")
    .replace(/ss/g, "")
    .replace(/[HmsX]/g, "");
  // Must have consumed at least one component
  if (stripped.length === fmt.length) return false;
  // Every remaining character must be an allowed literal
  for (const ch of stripped) {
    if (!FMT_LITERALS.has(ch)) return false;
  }
  return true;
}

// ── .cff file parsing and serialization ─────────────────────────────────────

/** Parse a .cff file into a FormatConfig. */
export function parseCff(source: string): FormatConfig | null {
  const normalized = source.replace(/\r\n/g, "\n");
  const blankIdx = normalized.indexOf("\n\n");
  if (blankIdx === -1) return null;

  const metaLines = normalized.substring(0, blankIdx).split("\n");
  const template = normalized.substring(blankIdx + 2); // skip the blank line

  const meta: Record<string, string> = {};
  for (const line of metaLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    const value = line.substring(colonIdx + 1).trim();
    if (key && value) meta[key] = value;
  }

  if (!meta.name || !meta.ext) return null;

  return {
    name: meta.name,
    extension: meta.ext,
    template,
  };
}

/** Serialize a FormatConfig to .cff file content. */
export function serializeCff(config: FormatConfig, source?: "builtin" | "custom"): string {
  let header = `name: ${config.name}\next: ${config.extension}`;
  if (source) header += `\nsource: ${source}`;
  return header + "\n\n" + config.template;
}
