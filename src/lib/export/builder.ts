/**
 * Export format template interpreter.
 *
 * Parses `.cff` (Codfish Format) files and executes templates against caption
 * data. No code generation, no `new Function()` — the app interprets templates
 * directly using token substitution and `{{#each}}` iteration.
 */

import type { SerializedCaption } from "./index";

// ── Public config type ──────────────────────────────────────────────────────

export interface FormatConfig {
  name: string;
  extension: string;
  template: string;
}

// ── Token definitions ───────────────────────────────────────────────────────

export interface TokenDef {
  token: string;
  label: string;
  description: string;
}

export interface TokenGroup {
  group: string;
  tokens: TokenDef[];
}

export const TOKEN_GROUPS: TokenGroup[] = [
  {
    group: "Caption",
    tokens: [
      { token: "{{index}}", label: "Index", description: "0-based. {{index:1}} for 1-based, {{index:N:W}} to pad to W digits" },
      { token: "{{text}}", label: "Text", description: "All lines joined with newlines" },
      { token: "{{text:space}}", label: "Text (spaces)", description: "All lines joined with spaces" },
    ],
  },
  {
    group: "Timing",
    tokens: [
      { token: "{{start}}", label: "Start", description: "Raw seconds, e.g. 1.2" },
      { token: "{{end}}", label: "End", description: "Raw seconds" },
      { token: "{{duration}}", label: "Duration", description: "end \u2212 start as raw seconds" },
      { token: "{{start:HH:mm:ss.SSS}}", label: "Timecode (VTT)", description: "00:00:01.200" },
      { token: "{{start:HH:mm:ss,SSS}}", label: "Timecode (SRT)", description: "00:00:01,200" },
      { token: "{{start:HH:mm:ss}}", label: "Timecode (whole)", description: "00:00:01" },
      { token: "{{start:X.SSS}}", label: "Total seconds", description: "1.200" },
    ],
  },
  {
    group: "Global",
    tokens: [
      { token: "{{count}}", label: "Count", description: "Total number of captions" },
      { token: "{{json}}", label: "JSON", description: "Full caption data as formatted JSON" },
    ],
  },
];

/** Flat list of all tokens (for validation / backward compat). */
export const TOKENS: TokenDef[] = TOKEN_GROUPS.flatMap((g) => g.tokens);

// ── Sample captions for live preview ────────────────────────────────────────

export const SAMPLE_CAPTIONS: SerializedCaption[] = [
  { index: 0, start: 1.2, end: 3.5, lines: ["Hello world"], speaker: "Alice" },
  { index: 1, start: 3.8, end: 5.1, lines: ["From the builder"], speaker: null },
  { index: 2, start: 6.0, end: 8.75, lines: ["Line one", "Line two"], speaker: "Bob" },
];

// ── Template interpreter ────────────────────────────────────────────────────

/** Execute a template against caption data. */
export function executeTemplate(template: string, captions: SerializedCaption[]): string {
  // Normalize line endings
  const t = template.replace(/\r\n/g, "\n");

  const eachStart = t.indexOf("{{#each}}");
  const eachEnd = t.indexOf("{{/each}}");

  // No iteration block — render entire template in global context
  if (eachStart === -1 || eachEnd === -1) {
    return resolveTokens(t, null, 0, captions.length, captions);
  }

  const header = t.substring(0, eachStart);
  let body = t.substring(eachStart + "{{#each}}".length, eachEnd);
  const footer = t.substring(eachEnd + "{{/each}}".length);

  // Strip leading newline from body (the one right after {{#each}})
  if (body.startsWith("\n")) body = body.substring(1);

  let result = resolveTokens(header, null, 0, captions.length, captions);

  for (let i = 0; i < captions.length; i++) {
    result += resolveTokens(body, captions[i], i, captions.length, captions);
  }

  result += resolveTokens(footer, null, 0, captions.length, captions);
  return result;
}

/** Preview a format config against sample data. */
export function previewTemplate(config: FormatConfig): string {
  try {
    return executeTemplate(config.template, SAMPLE_CAPTIONS);
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
): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    return resolveToken(key, caption, index, total, allCaptions);
  });
}

/** Resolve a single token key to its string value. */
function resolveToken(
  key: string,
  caption: SerializedCaption | null,
  index: number,
  total: number,
  allCaptions: SerializedCaption[],
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
  const h = Math.floor(t / 3600);
  const mn = Math.floor((t % 3600) / 60);
  const sc = Math.floor(t % 60);
  const fr = Math.round((t - Math.floor(t)) * 1e9) / 1e9;

  let out = "";
  let i = 0;
  while (i < fmt.length) {
    const c2 = fmt.substring(i, i + 2);
    const c3 = fmt.substring(i, i + 3);
    if (c3 === "SSS") {
      out += String(Math.floor(fr * 1000)).padStart(3, "0"); i += 3;
    } else if (c2 === "SS" && fmt.charAt(i + 2) !== "S") {
      out += String(Math.floor(fr * 100)).padStart(2, "0"); i += 2;
    } else if (c2 === "HH") {
      out += String(h).padStart(2, "0"); i += 2;
    } else if (c2 === "mm") {
      out += String(mn).padStart(2, "0"); i += 2;
    } else if (c2 === "ss") {
      out += String(sc).padStart(2, "0"); i += 2;
    } else if (fmt.charAt(i) === "X") {
      out += String(Math.floor(t)); i += 1;
    } else if (fmt.charAt(i) === "H") {
      out += String(h); i += 1;
    } else if (fmt.charAt(i) === "m") {
      out += String(mn); i += 1;
    } else if (fmt.charAt(i) === "s") {
      out += String(sc); i += 1;
    } else if (fmt.charAt(i) === "S") {
      out += String(Math.floor(fr * 10)); i += 1;
    } else {
      out += fmt.charAt(i); i += 1;
    }
  }
  return out;
}

// ── Token validation ────────────────────────────────────────────────────────

const VALID_TOKEN_KEYS = new Set([
  "index", "start", "end", "duration",
  "text", "text:space",
  "count", "json",
  "#each", "/each",
]);

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

/** Per-caption token keys (only meaningful inside {{#each}}). */
const PER_CAPTION_KEYS = new Set([
  "index", "start", "end", "duration", "text", "text:space",
]);

export function isPerCaptionToken(key: string): boolean {
  if (PER_CAPTION_KEYS.has(key)) return true;
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

  // Count {{#each}} and {{/each}}
  const eachOpens = (t.match(/\{\{#each\}\}/g) || []).length;
  const eachCloses = (t.match(/\{\{\/each\}\}/g) || []).length;

  if (eachOpens > 1) warnings.push({ message: "Multiple {{#each}} blocks found. Only one is supported." });
  if (eachCloses > 1) warnings.push({ message: "Multiple {{/each}} found. Only one is supported." });
  if (eachOpens !== eachCloses) warnings.push({ message: "Mismatched {{#each}} / {{/each}}." });

  // Check for per-caption tokens outside {{#each}}
  const eachStart = t.indexOf("{{#each}}");
  const eachEnd = t.indexOf("{{/each}}");
  const hasBlock = eachStart !== -1 && eachEnd !== -1 && eachStart < eachEnd;

  const outsideText = hasBlock
    ? t.substring(0, eachStart) + t.substring(eachEnd + "{{/each}}".length)
    : (eachOpens === 0 && eachCloses === 0 ? "" : t); // no block at all = skip this check

  for (const match of outsideText.matchAll(/\{\{([^}]+)\}\}/g)) {
    const key = match[1];
    if (isValidToken(key) && isPerCaptionToken(key)) {
      warnings.push({ message: `{{${key}}} is a per-caption token and won't work outside {{#each}}.` });
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
    .replace(/SSS/g, "")
    .replace(/HH/g, "")
    .replace(/mm/g, "")
    .replace(/ss/g, "")
    .replace(/SS/g, "")
    .replace(/[HmsXS]/g, "");
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

/** Check whether a .cff file source is a builtin format. */
export function isBuiltinFormat(source: string): boolean {
  const normalized = source.replace(/\r\n/g, "\n");
  const blankIdx = normalized.indexOf("\n\n");
  if (blankIdx === -1) return false;
  const metaSection = normalized.substring(0, blankIdx);
  return /^source:\s*builtin$/m.test(metaSection);
}
