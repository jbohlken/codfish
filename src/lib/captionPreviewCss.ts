/**
 * Custom caption-preview CSS — user styling for the video-panel caption
 * overlay. App-level preference (localStorage), never stored in the .cod,
 * never affects exports.
 *
 * Injection never touches raw text: user CSS is wrapped in a
 * `.caption-overlay { … }` scope, parsed through a constructed CSSStyleSheet,
 * checked for containment (a stray "}" would otherwise escape the scope and
 * restyle app UI from localStorage on every boot), and applied as the parsed
 * OBJECT via document.adoptedStyleSheets. Scoping semantics come from native
 * CSS nesting: bare declarations style the container, nested selectors get
 * the implicit & descendant. This is a footgun-guard, not a sandbox — a
 * selector like `body:has(&)` can deliberately reach app UI, which is
 * accepted (own machine, preview-only, native menu → Reset recovers); any
 * future import-someone-else's-styles feature must revisit that.
 *
 * The stock overlay look ALSO lives here (not components.css) so the editor
 * pre-fills with exactly the sheet that styles the overlay — no hidden
 * baseline fighting user rules on specificity. Requires constructable
 * stylesheets + CSS nesting (WebView2 evergreen; WKWebView ≥ Safari 16.5,
 * guaranteed by the macOS 13.4 minimumSystemVersion in tauri.conf.json).
 */

/** The factory caption look, and the editor's pre-fill / Reset target.
 *  Written as a worksheet: the values people actually tweak are present and
 *  annotated in place, extras wait in comments. Authored with class/attribute
 *  selectors only (safe under strict nesting; bare element selectors need
 *  relaxed nesting, Safari 17.2+). Bare declarations belong ABOVE the rules —
 *  engines before Safari 18.2 / Chrome 130 drop declarations that follow a
 *  nested rule. */
export const DEFAULT_CAPTION_PREVIEW_CSS = `/* Caption preview style — edit the values below; changes apply live.
   Hooks:
     .caption-overlay-line         one caption line
     [data-style="…"]              a styled run: emphasis, strong, underline
   Bare declarations at the TOP of this file (outside any rule) style the
   caption container itself — e.g. reposition captions with top / bottom. */

.caption-overlay-line {
  display: inline-block;
  background: rgba(0, 0, 0, 0.75); /* last number is opacity, 0 to 1 */
  color: #fff;
  font-size: clamp(12px, 2.5vw, 18px); /* smallest, scaling, largest */
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 3px;
  line-height: 1.4;
}

/* Bold runs get extra weight so they read against the 500 baseline. */
.caption-overlay-line [data-style="strong"] {
  font-weight: 800;
}

/* Ideas — move a line out of this comment to use it:
.caption-overlay-line { text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9); }
.caption-overlay-line { font-family: Georgia, serif; }
.caption-overlay-line { text-transform: uppercase; letter-spacing: 0.5px; }
*/

/* Captions at the top instead — bare declarations go above the first rule:
top: 32px;
bottom: auto;
*/
`;

const STORAGE_KEY = "codfish:captionPreviewCss";
// The value a Save overwrote — cheap recovery from Reset+Save (which is
// otherwise permanent: programmatic buffer replacement also clears the
// textarea's native undo). No UI yet; readable by hand or a future control.
const PREV_STORAGE_KEY = "codfish:captionPreviewCss.prev";

// Unterminated /* runs to EOF, exactly as engines treat it.
const stripComments = (text: string): string => text.replace(/\/\*[^]*?(?:\*\/|$)/g, " ");

/** Blank out comments, string contents, and unquoted url() contents in one
 *  pass, with proper interleaving (a comment can contain quotes, a string can
 *  contain "/*"). Follows the engine's tokenizer where it matters for the
 *  scans below: unterminated comments run to EOF, but an unescaped newline
 *  ends a string as a BAD-STRING (its contents — including any braces — are
 *  consumed, and scanning resumes after it, so a typo'd quote can't blind the
 *  at-rule scan to a @keyframes further down). What survives — structure
 *  characters and at-rule names outside strings/comments/urls — is what the
 *  structural scans may honestly react to, so content: "@import",
 *  [data-value="}"], or url(/img/@keyframes/x.png) can never false-trip them. */
function sanitizeForScan(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? text.length : end + 2;
    } else if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < text.length) {
        const s = text[i];
        if (s === "\\") { i += 2; continue; }
        if (s === "\n" || s === "\r") break; // bad-string: ends here, unclosed
        i++;
        if (s === c) { out += c; break; }
      }
    } else if (
      (c === "u" || c === "U") &&
      text.slice(i, i + 4).toLowerCase() === "url(" &&
      !/[\w-]/.test(out.slice(-1))
    ) {
      // Unquoted url(...) token: contents may legally contain "@" and braces.
      // A quoted argument falls through to the string branch instead.
      out += text.slice(i, i + 4);
      i += 4;
      const rest = text.slice(i).match(/^\s*["']/);
      if (!rest) {
        while (i < text.length) {
          const s = text[i];
          if (s === "\\") { i += 2; continue; }
          i++;
          if (s === ")") { out += ")"; break; }
        }
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// At-rules that are invalid when nested inside the scope wrapper: engines
// drop them silently while containment still passes, so a pasted @keyframes
// would "save fine, never animate". Rejected up front with a real message.
// They can't be allowed at the top level either — @font-face / @keyframes
// names are document-global and would leak into app UI. @media / @supports /
// @container nest legally and stay allowed.
const BANNED_AT_RULE = /@(?:-\w+-)?(keyframes|font-face|font-feature-values|font-palette-values|counter-style|view-transition|property|import|charset|namespace|page)\b/i;

/** True if a "}" closes more blocks than were opened — the wrapper would end
 *  early. Takes sanitizeForScan output (strings/comments already blanked).
 *  The CSSOM containment check below remains the authoritative backstop;
 *  this catches the edge it can't (a lone "}" whose escaped tail is empty). */
function hasUnbalancedClose(sanitized: string): boolean {
  let depth = 0;
  for (let i = 0; i < sanitized.length; i++) {
    const c = sanitized[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth < 0) return true;
  }
  return false;
}

export type CaptionCssValidation =
  | { ok: true; sheet: CSSStyleSheet }
  | { ok: false; error: string };

/** Parse + containment-check user CSS. Never throws. On ok, `sheet` is the
 *  ready-to-adopt object — always apply THAT, never re-inject the text. */
export function validateCaptionCss(text: string): CaptionCssValidation {
  const sanitized = sanitizeForScan(text);
  const banned = sanitized.match(BANNED_AT_RULE);
  if (banned) {
    return { ok: false, error: `@${banned[1].toLowerCase()} isn't supported in caption preview CSS.` };
  }
  if (hasUnbalancedClose(sanitized)) {
    return { ok: false, error: 'Unbalanced braces — a stray "}" ends the caption scope early.' };
  }
  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(`.caption-overlay {\n${text}\n}`);
  } catch {
    return { ok: false, error: "This CSS could not be parsed." };
  }
  // Containment: the wrapper must survive as the single top-level rule.
  // Anything that escaped it parses as additional top-level rules. NOTE:
  // happy-dom's parser diverges from real engines on the inputs that reach
  // this branch as the deciding check (e.g. bad-string edge cases) — don't
  // unit-test this backstop's verdicts; it's on the manual smoke matrix.
  const rules = sheet.cssRules;
  const only = rules.length === 1 ? (rules[0] as CSSStyleRule) : null;
  if (!only || only.selectorText !== ".caption-overlay") {
    return { ok: false, error: 'Unbalanced braces — a stray "}" ends the caption scope early.' };
  }
  return { ok: true, sheet };
}

/** Blank or comments-only — saving this means "back to stock". */
export function isEffectivelyEmpty(text: string): boolean {
  return stripComments(text).trim() === "";
}

// ── Advisory lint ──────────────────────────────────────────────────────────

/** Warnings, never blocking: the mistakes that parse "valid" and fail
 *  silently. Typo'd declarations are dropped by spec with no error; bare
 *  element selectors need relaxed nesting (Safari 17.2+, above our 16.5
 *  floor); bare declarations AFTER a rule are dropped before Safari 18.2 /
 *  Chrome 130. Best-effort tokenizer — quoted braces respected, exotic CSS
 *  may slip through; that's fine for advice. */
export function lintCaptionCss(text: string): string[] {
  const warnings: string[] = [];
  let depth = 0;
  let parens = 0;
  let quote: string | null = null;
  let buf = "";
  let sawTopLevelRule = false;

  const flushSelector = () => {
    const stmt = buf.trim();
    buf = "";
    if (!stmt) return;
    if (depth === 1) sawTopLevelRule = true;
    // A "selector" shaped like `prop: value` with an embedded newline is a
    // declaration that lost its semicolon and merged into the next rule —
    // say that, not something misleading about the mangled selector text.
    if (/^[a-zA-Z-]+\s*:/.test(stmt) && stmt.includes("\n")) {
      const firstLine = stmt.split("\n", 1)[0].trim();
      warnings.push(`"${firstLine}" — missing semicolon? Without it this declaration merges into the next rule and both are dropped.`);
      return;
    }
    // Bare element selectors need relaxed nesting (Safari 17.2+; the app
    // floor only guarantees 16.5) at ANY nesting depth, including inside
    // @media blocks and deeper rules.
    if (/^[a-zA-Z]/.test(stmt) && !stmt.startsWith("@")) {
      warnings.push(
        `"${stmt}" — element selectors may not work on older macOS; prefer .caption-overlay-line or [data-style="…"].`,
      );
    }
  };

  const flushDeclaration = () => {
    const stmt = buf.trim();
    buf = "";
    if (!stmt) return;
    const colon = stmt.indexOf(":");
    if (colon <= 0) return;
    const prop = stmt.slice(0, colon).trim();
    const value = stmt.slice(colon + 1).replace(/!\s*important\s*$/i, "").trim();
    if (depth === 0 && sawTopLevelRule) {
      warnings.push(`"${prop}" — bare declarations after a rule may be ignored on some systems; move them above the first rule.`);
    }
    if (prop.startsWith("--") || !value) return;
    if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
      let known = true;
      try { known = CSS.supports(prop, value); } catch { /* stay quiet */ }
      if (!known) warnings.push(`"${prop}: ${value}" — unrecognized declaration (check the spelling).`);
    }
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      buf += c;
      if (c === "\\") { buf += text[i + 1] ?? ""; i++; }
      else if (c === quote) quote = null;
      continue;
    }
    // Comments skipped inline (not pre-stripped): a "/*" inside a string
    // must not swallow the rest of the buffer.
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; }
    else if (c === "(") { parens++; buf += c; }
    else if (c === ")") { parens = Math.max(0, parens - 1); buf += c; }
    else if (c === "{" && parens === 0) { depth++; flushSelector(); }
    else if (c === "}" && parens === 0) { flushDeclaration(); depth = Math.max(0, depth - 1); }
    else if (c === ";" && parens === 0) { flushDeclaration(); }
    else buf += c;
  }
  flushDeclaration();
  return warnings;
}

// ── Adopted-sheet registry ─────────────────────────────────────────────────

/** Ordered named slots reassembled into document.adoptedStyleSheets. One
 *  slot today; a future project-scoped sheet (e.g. <c.class> speaker colors
 *  generated from .cod class definitions, which must not bleed across
 *  projects the way this app-level sheet would) appends a slot after "look"
 *  without touching this code. Foreign adopted sheets are preserved. */
export type PreviewSlot = "look";
const SLOT_ORDER: PreviewSlot[] = ["look"];
const slots = new Map<PreviewSlot, CSSStyleSheet>();
const ours = new Set<CSSStyleSheet>();

export function setPreviewSheet(slot: PreviewSlot, sheet: CSSStyleSheet | null): void {
  if (sheet) slots.set(slot, sheet);
  else slots.delete(slot);
  const mine = SLOT_ORDER.filter((k) => slots.has(k)).map((k) => slots.get(k)!);
  const foreign = [...document.adoptedStyleSheets].filter((s) => !ours.has(s));
  ours.clear();
  for (const s of mine) ours.add(s);
  document.adoptedStyleSheets = [...foreign, ...mine];
}

export function getPreviewSheet(slot: PreviewSlot): CSSStyleSheet | null {
  return slots.get(slot) ?? null;
}

/** Validate and adopt; false (current sheet stays) on invalid. */
export function applyCaptionCss(text: string): boolean {
  const v = validateCaptionCss(text);
  if (!v.ok) return false;
  setPreviewSheet("look", v.sheet);
  return true;
}

// ── Persistence ────────────────────────────────────────────────────────────

export function loadStoredCaptionCss(): string | null {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

export function loadPreviousCaptionCss(): string | null {
  try { return localStorage.getItem(PREV_STORAGE_KEY); } catch { return null; }
}

/** What the editor opens with: the stored override, else stock. A hand-edited
 *  blank/comment-only stored value counts as absent (the app itself never
 *  stores one — saveCaptionCss removes the key instead). */
export function effectiveCaptionCss(): string {
  const stored = loadStoredCaptionCss();
  return stored !== null && !isEffectivelyEmpty(stored) ? stored : DEFAULT_CAPTION_PREVIEW_CSS;
}

/** Persist. Blank/comment-only text and the untouched default both mean
 *  "back to stock" (key removed — so future default improvements reach users
 *  who never customized). The overwritten value lands in .prev. */
export function saveCaptionCss(text: string): void {
  try {
    const next = isEffectivelyEmpty(text) || text === DEFAULT_CAPTION_PREVIEW_CSS ? null : text;
    const current = localStorage.getItem(STORAGE_KEY);
    if (current !== null && current !== next) localStorage.setItem(PREV_STORAGE_KEY, current);
    if (next === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch { /* best-effort */ }
}

// ── Boot ───────────────────────────────────────────────────────────────────

// Module scope — the theme.ts idiom: runs on first import, before the app
// renders, so the overlay never paints unstyled. Invalid stored text
// (hand-edited localStorage, a future version's syntax) degrades to stock;
// the editor still shows it, with its error, so it can be fixed.
function boot(): void {
  try {
    const stored = loadStoredCaptionCss();
    const hasOverride = stored !== null && !isEffectivelyEmpty(stored);
    if (hasOverride && applyCaptionCss(stored)) return;
    // Applying the default disambiguates: if IT fails too, the engine lacks
    // constructable stylesheets (unreachable within the declared macOS 13.4
    // floor, e.g. a sideloaded build) — don't blame the user's CSS for that.
    if (applyCaptionCss(DEFAULT_CAPTION_PREVIEW_CSS)) {
      if (hasOverride) {
        console.warn("codfish: stored caption preview CSS is invalid; using the default.");
      }
    } else {
      console.warn("codfish: caption preview styling is unavailable on this engine.");
    }
  } catch (e) {
    // Never let styling take the boot down.
    console.warn("codfish: caption preview styling unavailable:", e);
  }
}
boot();
