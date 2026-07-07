// Scope note (pinned by empirical happy-dom probes during design review):
// happy-dom agrees with real engines on the containment/escape truth table,
// bare declarations, and adoptedStyleSheets assignment — those are tested
// here. It diverges on nested-rule PRESERVATION (drops them while still
// reporting one top-level rule) and invalid-declaration dropping (retains
// them), and getComputedStyle ignores adopted sheets entirely — so nothing
// here asserts nested-rule content or applied styling; that's the manual
// smoke matrix on WebView2 + WKWebView.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CAPTION_PREVIEW_CSS,
  applyCaptionCss,
  effectiveCaptionCss,
  getPreviewSheet,
  isEffectivelyEmpty,
  lintCaptionCss,
  loadPreviousCaptionCss,
  loadStoredCaptionCss,
  saveCaptionCss,
  setPreviewSheet,
  validateCaptionCss,
} from "../captionPreviewCss";

const STORAGE_KEY = "codfish:captionPreviewCss";

describe("validateCaptionCss — containment", () => {
  it("accepts the shipped default", () => {
    expect(validateCaptionCss(DEFAULT_CAPTION_PREVIEW_CSS).ok).toBe(true);
  });

  it("accepts a nested class rule", () => {
    expect(validateCaptionCss('.caption-overlay-line { color: yellow }').ok).toBe(true);
  });

  it("accepts bare declarations", () => {
    expect(validateCaptionCss("top: 32px;\nbottom: auto;").ok).toBe(true);
  });

  it("rejects a stray closing brace that escapes the scope", () => {
    const v = validateCaptionCss("color: red; } * { display: none; }");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/braces/i);
  });

  it("rejects a lone closing brace (empty escaped tail)", () => {
    expect(validateCaptionCss("}").ok).toBe(false);
  });

  it("rejects an escape that re-opens a rule", () => {
    expect(validateCaptionCss("color: red } .foo {").ok).toBe(false);
  });

  it("accepts an unclosed open brace (EOF closes open blocks per spec)", () => {
    expect(validateCaptionCss(".caption-overlay-line { color: red").ok).toBe(true);
  });

  it("does not treat a quoted brace as structure", () => {
    expect(validateCaptionCss('.caption-overlay-line { content: "}" }').ok).toBe(true);
  });

  it("allows nested @media", () => {
    expect(
      validateCaptionCss("@media (min-width: 100px) { .caption-overlay-line { color: red } }").ok,
    ).toBe(true);
  });
});

describe("validateCaptionCss — at-rule pre-scan", () => {
  it.each([
    "keyframes", "font-face", "font-feature-values", "font-palette-values",
    "counter-style", "view-transition", "property", "import", "charset", "namespace", "page",
  ])(
    "rejects @%s with a named error",
    (name) => {
      const v = validateCaptionCss(`@${name} something { }`);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toContain(`@${name}`);
    },
  );

  it("rejects vendor-prefixed variants", () => {
    expect(validateCaptionCss("@-webkit-keyframes fade { }").ok).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(validateCaptionCss("@KEYFRAMES fade { }").ok).toBe(false);
  });

  it("ignores at-rule names inside comments", () => {
    expect(validateCaptionCss("/* @keyframes note */ .caption-overlay-line { color: red }").ok).toBe(true);
  });

  it("ignores at-rule names inside strings", () => {
    expect(validateCaptionCss('.caption-overlay-line { content: "@import" }').ok).toBe(true);
    expect(validateCaptionCss('[data-value="@keyframes"] { color: red }').ok).toBe(true);
  });

  it("treats an unterminated comment as running to EOF (per spec)", () => {
    expect(validateCaptionCss("/* TODO @keyframes later").ok).toBe(true);
    expect(validateCaptionCss(".caption-overlay-line { color: red }\n/* note }").ok).toBe(true);
  });

  it("does not let an unterminated string false-trip the scans", () => {
    expect(validateCaptionCss('.caption-overlay-line { content: "@import').ok).toBe(true);
  });

  it("ends a string at an unescaped newline (bad-string) so at-rules below a typo'd quote are still caught", () => {
    const v = validateCaptionCss(".a { content: 'oops }\n@keyframes fade { from { opacity: 0 } }");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("@keyframes");
  });

  it("ignores at-rule names and braces inside unquoted url() tokens", () => {
    expect(validateCaptionCss(".caption-overlay-line { background: url(/img/@keyframes/x.png) }").ok).toBe(true);
    expect(validateCaptionCss(".caption-overlay-line { background: url(https://x.test/@import.png) }").ok).toBe(true);
    expect(validateCaptionCss('.caption-overlay-line { background: url("/img/@keyframes/x.png") }').ok).toBe(true);
  });
});

describe("isEffectivelyEmpty", () => {
  it("treats blank and comment-only text as empty", () => {
    expect(isEffectivelyEmpty("")).toBe(true);
    expect(isEffectivelyEmpty("  \n\t ")).toBe(true);
    expect(isEffectivelyEmpty("/* just a note */")).toBe(true);
    expect(isEffectivelyEmpty("/* a */ \n /* b */")).toBe(true);
    expect(isEffectivelyEmpty("/* unterminated comment runs to EOF")).toBe(true);
  });

  it("treats any real content as non-empty", () => {
    expect(isEffectivelyEmpty("color: red")).toBe(false);
    expect(isEffectivelyEmpty("/* a */ color: red")).toBe(false);
  });

  it("effectiveCaptionCss treats a hand-stored blank value as absent", () => {
    localStorage.clear();
    localStorage.setItem("codfish:captionPreviewCss", "");
    expect(effectiveCaptionCss()).toBe(DEFAULT_CAPTION_PREVIEW_CSS);
    localStorage.clear();
  });
});

describe("persistence", () => {
  beforeEach(() => localStorage.clear());

  it("stores custom text and serves it as the effective CSS", () => {
    saveCaptionCss(".caption-overlay-line { color: red }");
    expect(loadStoredCaptionCss()).toBe(".caption-overlay-line { color: red }");
    expect(effectiveCaptionCss()).toBe(".caption-overlay-line { color: red }");
  });

  it("treats blank, comment-only, and untouched-default saves as reset", () => {
    for (const text of ["", "  ", "/* nothing */", DEFAULT_CAPTION_PREVIEW_CSS]) {
      saveCaptionCss(".caption-overlay-line { color: red }");
      saveCaptionCss(text);
      expect(loadStoredCaptionCss()).toBeNull();
      expect(effectiveCaptionCss()).toBe(DEFAULT_CAPTION_PREVIEW_CSS);
    }
  });

  it("stashes the overwritten value in .prev", () => {
    saveCaptionCss("a { color: red }");
    expect(loadPreviousCaptionCss()).toBeNull();
    saveCaptionCss("b { color: red }");
    expect(loadPreviousCaptionCss()).toBe("a { color: red }");
    saveCaptionCss("b { color: red }"); // unchanged — no re-stash
    expect(loadPreviousCaptionCss()).toBe("a { color: red }");
  });

  it("stashes on reset too", () => {
    saveCaptionCss("a { color: red }");
    saveCaptionCss("");
    expect(loadStoredCaptionCss()).toBeNull();
    expect(loadPreviousCaptionCss()).toBe("a { color: red }");
  });
});

describe("adopted-sheet registry", () => {
  beforeEach(() => localStorage.clear());

  it("applies a valid sheet to document.adoptedStyleSheets", () => {
    expect(applyCaptionCss(".caption-overlay-line { color: teal }")).toBe(true);
    const sheet = getPreviewSheet("look");
    expect(sheet).not.toBeNull();
    expect([...document.adoptedStyleSheets]).toContain(sheet);
  });

  it("keeps the current sheet when the new text is invalid", () => {
    applyCaptionCss(".caption-overlay-line { color: teal }");
    const before = getPreviewSheet("look");
    expect(applyCaptionCss("} * { display: none }")).toBe(false);
    expect(getPreviewSheet("look")).toBe(before);
    expect([...document.adoptedStyleSheets]).toContain(before);
  });

  it("replaces rather than accumulates its own sheets", () => {
    applyCaptionCss(".caption-overlay-line { color: teal }");
    const first = getPreviewSheet("look");
    applyCaptionCss(".caption-overlay-line { color: plum }");
    const sheets = [...document.adoptedStyleSheets];
    expect(sheets).toContain(getPreviewSheet("look"));
    expect(sheets).not.toContain(first);
  });

  it("preserves foreign adopted sheets", () => {
    const foreign = new CSSStyleSheet();
    foreign.replaceSync(".zz-foreign { color: red }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, foreign];
    applyCaptionCss(".caption-overlay-line { color: teal }");
    expect([...document.adoptedStyleSheets]).toContain(foreign);
    setPreviewSheet("look", null);
    expect([...document.adoptedStyleSheets]).toContain(foreign);
    expect(getPreviewSheet("look")).toBeNull();
  });
});

describe("lintCaptionCss", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubSupports = (impl: (prop: string, value: string) => boolean) => {
    vi.stubGlobal("CSS", { supports: impl });
  };

  it("lints the shipped default clean", () => {
    stubSupports(() => true);
    expect(lintCaptionCss(DEFAULT_CAPTION_PREVIEW_CSS)).toEqual([]);
  });

  it("warns on bare element selectors, not class/attribute/& selectors", () => {
    stubSupports(() => true);
    expect(lintCaptionCss("span { color: red }").some((w) => w.includes("element selectors"))).toBe(true);
    expect(lintCaptionCss(".caption-overlay-line { color: red }")).toEqual([]);
    expect(lintCaptionCss('[data-style="strong"] { color: red }')).toEqual([]);
    expect(lintCaptionCss("&:hover { color: red }")).toEqual([]);
  });

  it("does not element-warn on nested @media", () => {
    stubSupports(() => true);
    expect(lintCaptionCss("@media (min-width: 10px) { .a { color: red } }")).toEqual([]);
  });

  it("warns on bare declarations AFTER a rule, not before", () => {
    stubSupports(() => true);
    const after = lintCaptionCss(".caption-overlay-line { color: red }\ntop: 10px;");
    expect(after.some((w) => w.includes("above the first rule"))).toBe(true);
    expect(lintCaptionCss("top: 10px;\n.caption-overlay-line { color: red }")).toEqual([]);
  });

  it("warns on element selectors at any nesting depth", () => {
    stubSupports(() => true);
    expect(
      lintCaptionCss(".caption-overlay-line { span { color: red } }").some((w) => w.includes("element selectors")),
    ).toBe(true);
    expect(
      lintCaptionCss("@media (min-width: 10px) { span { color: red } }").some((w) => w.includes("element selectors")),
    ).toBe(true);
  });

  it("diagnoses a missing semicolon instead of mislabeling the merged text as a selector", () => {
    stubSupports(() => true);
    const warnings = lintCaptionCss("top: 10px\n.caption-overlay-line { color: red }");
    expect(warnings.some((w) => w.includes("missing semicolon"))).toBe(true);
    expect(warnings.some((w) => w.includes("element selectors"))).toBe(false);
  });

  it("does not split declarations at semicolons inside url() values", () => {
    const supports = vi.fn(() => true);
    stubSupports(supports);
    expect(lintCaptionCss(".a { background: url(data:image/png;base64,AAAA) }")).toEqual([]);
    expect(supports).toHaveBeenCalledWith("background", "url(data:image/png;base64,AAAA)");
  });

  it("skips comments inline so a \"/*\" inside a string can't swallow later lines", () => {
    stubSupports((prop) => prop !== "colr");
    const warnings = lintCaptionCss('.a { content: "/*" }\n.b-line { colr: red }');
    expect(warnings.some((w) => w.includes("colr"))).toBe(true);
  });

  it("flags unrecognized declarations via CSS.supports", () => {
    stubSupports((prop) => prop !== "colr");
    const warnings = lintCaptionCss(".caption-overlay-line { colr: red; color: red }");
    expect(warnings.some((w) => w.includes("colr"))).toBe(true);
    expect(warnings.some((w) => w.includes('"color: red"'))).toBe(false);
  });

  it("strips !important before the supports check and skips custom properties", () => {
    const supports = vi.fn(() => true);
    stubSupports(supports);
    lintCaptionCss(".a { color: red !important; --mine: 12px }");
    expect(supports).toHaveBeenCalledWith("color", "red");
    expect(supports).toHaveBeenCalledTimes(1);
  });

  it("stays quiet without a CSS.supports implementation", () => {
    vi.stubGlobal("CSS", undefined);
    expect(lintCaptionCss(".a { colr: red }")).toEqual([]);
  });
});

describe("boot", () => {
  // Each case re-imports a fresh module instance so boot() runs against the
  // prepared localStorage (the top-level import's boot already ran long ago).
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("applies stock when nothing is stored", async () => {
    localStorage.clear();
    vi.resetModules();
    const fresh = await import("../captionPreviewCss");
    expect(fresh.getPreviewSheet("look")).not.toBeNull();
  });

  it("applies valid stored text", async () => {
    localStorage.clear();
    localStorage.setItem(STORAGE_KEY, ".caption-overlay-line { color: teal }");
    vi.resetModules();
    const fresh = await import("../captionPreviewCss");
    expect(fresh.getPreviewSheet("look")).not.toBeNull();
  });

  it("degrades invalid stored text to stock with a warning, keeping the text", async () => {
    localStorage.clear();
    localStorage.setItem(STORAGE_KEY, "} * { display: none }");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    const fresh = await import("../captionPreviewCss");
    expect(fresh.getPreviewSheet("look")).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    // Still stored — the editor shows it (with its error) so it can be fixed.
    expect(localStorage.getItem(STORAGE_KEY)).toBe("} * { display: none }");
  });

  it("storage key matches the documented name", () => {
    localStorage.clear();
    saveCaptionCss(".caption-overlay-line { color: red }");
    expect(localStorage.getItem(STORAGE_KEY)).toBe(".caption-overlay-line { color: red }");
    localStorage.clear();
  });
});
