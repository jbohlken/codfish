/**
 * Token autocomplete helpers for the template editor.
 *
 * Pure (DOM-free) logic for detecting an in-progress `{{token}}` at the caret,
 * filtering the token catalog, and looking up descriptions for hover tooltips.
 */

import { TOKENS, type TokenDef } from "./builder";

/** Characters that may appear inside a token body (between `{{` and `}}`). */
const TOKEN_CHAR = /^[a-zA-Z0-9_/:.,\-]*$/;

export interface TokenEditRange {
  /** Index of the first `{` of the opening `{{`. */
  start: number;
  /** Index one past the last char that should be replaced (past any trailing `}}`). */
  end: number;
  /** Text between `{{` and the caret — used for filtering. */
  prefix: string;
}

/**
 * If the caret is inside an in-progress `{{...}}` token, return the
 * replaceable range and the prefix typed so far. Returns null otherwise.
 */
export function extractTokenPrefix(text: string, caret: number): TokenEditRange | null {
  const before = text.slice(0, caret);
  const m = /\{\{([^{}\n]*)$/.exec(before);
  if (!m) return null;
  const prefix = m[1];
  if (!TOKEN_CHAR.test(prefix)) return null;

  const start = m.index;

  // Scan forward to consume the rest of the token body and any closing `}}`.
  const after = text.slice(caret);
  const afterMatch = /^([^{}\n]*)(\}\})?/.exec(after);
  const afterLen = afterMatch ? afterMatch[0].length : 0;

  return { start, end: caret + afterLen, prefix };
}

export interface AutocompleteSuggestion {
  def: TokenDef;
  /** True if this is a base token that has `:`-parameterized variants. */
  hasVariants: boolean;
}

// Map of base (the part before the first `:`) → true if variants exist.
const HAS_VARIANTS = new Set<string>();
for (const t of TOKENS) {
  const key = t.token.slice(2, -2);
  const colonIdx = key.indexOf(":");
  if (colonIdx !== -1) HAS_VARIANTS.add(key.slice(0, colonIdx));
}

const isBase = (key: string) => !key.includes(":");

/**
 * Hierarchical filter:
 *  - No `:` in the prefix → show base tokens only (the ones that aren't
 *    parameterized variants), startsWith-matched on the prefix.
 *  - `:` in the prefix → variant mode: show parameterized variants whose
 *    key startsWith the full prefix.
 *
 * Bases that have variants are flagged with `hasVariants` so the popup can
 * hint at the `type : for more` affordance.
 */
export function filterAutocomplete(prefix: string): AutocompleteSuggestion[] {
  const p = prefix.toLowerCase();
  const variantMode = p.includes(":");
  const results: AutocompleteSuggestion[] = [];
  for (const def of TOKENS) {
    if (def.hidden) continue;
    const key = def.token.slice(2, -2).toLowerCase();
    if (!key.startsWith(p)) continue;
    const base = isBase(key);
    if (variantMode) {
      if (base) continue; // only variants in variant mode
    } else {
      if (!base) continue; // only bases in base mode
    }
    results.push({ def, hasVariants: !variantMode && HAS_VARIANTS.has(key) });
  }
  return results;
}

// ── Grammar help (shown in the popup when typing a parameterized variant) ───

export interface GrammarHelp {
  /** One-line signature, e.g. `{{index:N}} or {{index:N:W}}`. */
  signature: string;
  /** Explanatory lines, one per row in the popup header. */
  lines: string[];
}

const TIME_FORMAT_LINES = [
  "HH hours · mm min · ss sec · S+ fractional (S=tenths, SS=hundredths, SSS=millis, …) · X total seconds",
  "Drop parts you don't need: {{start:mm:ss}} → 01:30",
];

const GRAMMAR_BY_BASE: Record<string, GrammarHelp> = {
  index: {
    signature: "{{index:N}} or {{index:N:W}}",
    lines: [
      "N = integer offset (use 1 for 1-based)",
      "W = zero-pad to W digits (optional, ≥ 1)",
    ],
  },
  start: { signature: "{{start:FORMAT}}", lines: TIME_FORMAT_LINES },
  end: { signature: "{{end:FORMAT}}", lines: TIME_FORMAT_LINES },
  duration: { signature: "{{duration:FORMAT}}", lines: TIME_FORMAT_LINES },
};

/**
 * Look up grammar help for the base of a variant-mode prefix. Returns null
 * for prefixes without a `:`, or for parameterized bases we don't document.
 */
export function getGrammarForPrefix(prefix: string): GrammarHelp | null {
  const colonIdx = prefix.indexOf(":");
  if (colonIdx === -1) return null;
  const base = prefix.slice(0, colonIdx).toLowerCase();
  return GRAMMAR_BY_BASE[base] ?? null;
}

// ── Description lookup (for hover tooltips on highlighted tokens) ────────────

const DESC_BY_KEY = new Map<string, string>();
for (const t of TOKENS) {
  DESC_BY_KEY.set(t.token.slice(2, -2), t.description);
}

/**
 * Look up the description for a token body (without `{{ }}`).
 * Falls back to the base token (text before the first `:`) for parameterized
 * variants that aren't in the preset catalog — e.g. `index:1` → `index`.
 */
export function lookupTokenDescription(key: string): string | null {
  const exact = DESC_BY_KEY.get(key);
  if (exact) return exact;
  const colonIdx = key.indexOf(":");
  if (colonIdx === -1) return null;
  const base = key.slice(0, colonIdx);
  return DESC_BY_KEY.get(base) ?? null;
}
