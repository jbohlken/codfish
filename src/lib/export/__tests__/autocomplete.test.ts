import { describe, it, expect } from "vitest";
import {
  extractTokenPrefix,
  filterAutocomplete,
  getGrammarForPrefix,
  lookupTokenDescription,
} from "../autocomplete";

// ── extractTokenPrefix ───────────────────────────────────────────────────────

describe("extractTokenPrefix", () => {
  it("returns null for text with no open token", () => {
    expect(extractTokenPrefix("hello world", 5)).toBeNull();
  });

  it("returns null when caret is before any open token", () => {
    expect(extractTokenPrefix("hi {{start}}", 2)).toBeNull();
  });

  it("detects a freshly-typed {{ with empty prefix", () => {
    const r = extractTokenPrefix("hi {{", 5);
    expect(r).toEqual({ start: 3, end: 5, prefix: "" });
  });

  it("extracts the prefix typed so far inside an unclosed token", () => {
    const r = extractTokenPrefix("hi {{sta", 8);
    expect(r).toEqual({ start: 3, end: 8, prefix: "sta" });
  });

  it("extends end through trailing token chars and closing braces", () => {
    // caret is between "sta" and "rt}}" — insert should replace the whole {{start}}
    const r = extractTokenPrefix("hi {{start}}", 8);
    expect(r).toEqual({ start: 3, end: 12, prefix: "sta" });
  });

  it("extends end through trailing token chars when no closing braces", () => {
    const r = extractTokenPrefix("hi {{start", 8);
    expect(r).toEqual({ start: 3, end: 10, prefix: "sta" });
  });

  it("finds the most recent {{ when multiple tokens exist", () => {
    const text = "{{index}}{{sta";
    const r = extractTokenPrefix(text, text.length);
    expect(r).toEqual({ start: 9, end: 14, prefix: "sta" });
  });

  it("stops at a newline between {{ and caret", () => {
    const r = extractTokenPrefix("{{\n  sta", 8);
    expect(r).toBeNull();
  });

  it("returns null when prefix contains a space", () => {
    const r = extractTokenPrefix("{{hello world", 13);
    expect(r).toBeNull();
  });

  it("returns null when the prefix regex already crossed a closing brace", () => {
    // After the }}, caret is in plain text — not inside a token.
    const r = extractTokenPrefix("{{start}} rest", 14);
    expect(r).toBeNull();
  });

  it("allows hyphens, colons, commas, periods, and slashes", () => {
    const text = "{{start-smpte-df";
    expect(extractTokenPrefix(text, text.length)?.prefix).toBe("start-smpte-df");
    const text2 = "{{start:HH:mm:ss,SSS";
    expect(extractTokenPrefix(text2, text2.length)?.prefix).toBe("start:HH:mm:ss,SSS");
  });

  it("allows the {{/each}} prefix with leading slash", () => {
    const text = "{{/ea";
    expect(extractTokenPrefix(text, text.length)?.prefix).toBe("/ea");
  });

  it("allows the {{each}} prefix", () => {
    const text = "{{ea";
    expect(extractTokenPrefix(text, text.length)?.prefix).toBe("ea");
  });
});

// ── filterAutocomplete ───────────────────────────────────────────────────────

const tokens = (matches: { def: { token: string } }[]) => matches.map((m) => m.def.token);

describe("filterAutocomplete", () => {
  it("returns only base tokens for empty prefix (no variants)", () => {
    const matches = filterAutocomplete("");
    const keys = tokens(matches);
    expect(keys).toContain("{{text}}");
    expect(keys).toContain("{{start}}");
    expect(keys).toContain("{{end}}");
    expect(keys).toContain("{{duration}}");
    expect(keys).toContain("{{index}}");
    // Variants must be absent in base mode.
    expect(keys).not.toContain("{{start:HH:mm:ss,SSS}}");
    expect(keys).not.toContain("{{index:1}}");
    expect(keys).not.toContain("{{text:space}}");
  });

  it("filters bases by startsWith on the token body", () => {
    const matches = filterAutocomplete("sta");
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m.def.token.slice(2).toLowerCase().startsWith("sta")).toBe(true);
      // Still base-mode: no variants.
      expect(m.def.token.slice(2, -2).includes(":")).toBe(false);
    }
  });

  it("is case-insensitive", () => {
    const lower = tokens(filterAutocomplete("start"));
    const upper = tokens(filterAutocomplete("START"));
    expect(upper).toEqual(lower);
  });

  it("switches to variant mode when the prefix contains a colon", () => {
    const matches = tokens(filterAutocomplete("start:"));
    expect(matches).toContain("{{start:HH:mm:ss,SSS}}");
    expect(matches).toContain("{{start:HH:mm:ss.SSS}}");
    expect(matches).toContain("{{start:HH:mm:ss}}");
    expect(matches).toContain("{{start:X.SSS}}");
    // Variant mode excludes the base.
    expect(matches).not.toContain("{{start}}");
  });

  it("surfaces end: and duration: variants in variant mode", () => {
    const ends = tokens(filterAutocomplete("end:"));
    expect(ends).toContain("{{end:HH:mm:ss,SSS}}");
    expect(ends).toContain("{{end:X.SSS}}");
    const durs = tokens(filterAutocomplete("duration:"));
    expect(durs).toContain("{{duration:HH:mm:ss,SSS}}");
    expect(durs).toContain("{{duration:X.SSS}}");
  });

  it("surfaces index variants in variant mode", () => {
    const idx = tokens(filterAutocomplete("index:"));
    expect(idx).toContain("{{index:1}}");
  });

  it("further filters variants by the typed suffix", () => {
    const matches = tokens(filterAutocomplete("start:HH"));
    expect(matches).toContain("{{start:HH:mm:ss}}");
    expect(matches).toContain("{{start:HH:mm:ss.SSS}}");
    expect(matches).not.toContain("{{start:X.SSS}}");
  });

  it("returns empty when nothing matches", () => {
    expect(filterAutocomplete("zzz_no_such_token")).toEqual([]);
  });

  it("matches {{each}} via the 'ea' prefix", () => {
    const matches = tokens(filterAutocomplete("ea"));
    expect(matches).toContain("{{each}}");
  });

  it("flags bases that have variants with hasVariants=true", () => {
    const matches = filterAutocomplete("");
    const start = matches.find((m) => m.def.token === "{{start}}");
    const end = matches.find((m) => m.def.token === "{{end}}");
    const duration = matches.find((m) => m.def.token === "{{duration}}");
    const index = matches.find((m) => m.def.token === "{{index}}");
    const text = matches.find((m) => m.def.token === "{{text}}");
    expect(start?.hasVariants).toBe(true);
    expect(end?.hasVariants).toBe(true);
    expect(duration?.hasVariants).toBe(true);
    expect(index?.hasVariants).toBe(true);
    expect(text?.hasVariants).toBe(true); // {{text:space}} exists
  });

  it("does not flag bases without variants", () => {
    const matches = filterAutocomplete("");
    const count = matches.find((m) => m.def.token === "{{count}}");
    const json = matches.find((m) => m.def.token === "{{json}}");
    const startSmpte = matches.find((m) => m.def.token === "{{start-smpte}}");
    expect(count?.hasVariants).toBe(false);
    expect(json?.hasVariants).toBe(false);
    expect(startSmpte?.hasVariants).toBe(false);
  });

  it("does not flag variants themselves in variant mode", () => {
    const matches = filterAutocomplete("start:");
    for (const m of matches) {
      expect(m.hasVariants).toBe(false);
    }
  });
});

// ── getGrammarForPrefix ──────────────────────────────────────────────────────

describe("getGrammarForPrefix", () => {
  it("returns null when the prefix has no colon (base mode)", () => {
    expect(getGrammarForPrefix("")).toBeNull();
    expect(getGrammarForPrefix("sta")).toBeNull();
    expect(getGrammarForPrefix("index")).toBeNull();
  });

  it("returns grammar for {{index:…}}", () => {
    const g = getGrammarForPrefix("index:");
    expect(g).not.toBeNull();
    expect(g!.signature).toMatch(/index:N/);
    expect(g!.lines.length).toBeGreaterThan(0);
  });

  it("returns grammar for {{start:…}}, {{end:…}}, {{duration:…}}", () => {
    expect(getGrammarForPrefix("start:")?.signature).toContain("start");
    expect(getGrammarForPrefix("end:")?.signature).toContain("end");
    expect(getGrammarForPrefix("duration:")?.signature).toContain("duration");
  });

  it("uses the same time format lines for start/end/duration", () => {
    const start = getGrammarForPrefix("start:")!;
    const end = getGrammarForPrefix("end:")!;
    const duration = getGrammarForPrefix("duration:")!;
    expect(end.lines).toEqual(start.lines);
    expect(duration.lines).toEqual(start.lines);
  });

  it("still returns grammar when the user has typed past the colon", () => {
    expect(getGrammarForPrefix("index:99")).not.toBeNull();
    expect(getGrammarForPrefix("start:HH:mm")).not.toBeNull();
  });

  it("is case-insensitive on the base", () => {
    expect(getGrammarForPrefix("INDEX:")).not.toBeNull();
    expect(getGrammarForPrefix("Start:HH")).not.toBeNull();
  });

  it("returns null for parameterized bases we don't document", () => {
    // {{text:space}} is a one-off variant, no grammar entry
    expect(getGrammarForPrefix("text:")).toBeNull();
  });

  it("returns null for unknown bases", () => {
    expect(getGrammarForPrefix("nope:")).toBeNull();
  });
});

// ── lookupTokenDescription ───────────────────────────────────────────────────

describe("lookupTokenDescription", () => {
  it("returns the description for an exact token key", () => {
    const desc = lookupTokenDescription("text");
    expect(desc).toBeTruthy();
    expect(desc).toMatch(/lines/i);
  });

  it("returns the exact description for parameterized presets", () => {
    const desc = lookupTokenDescription("start:HH:mm:ss,SSS");
    expect(desc).toBe("00:00:01,200");
  });

  it("falls back to the base token for custom parameter variants", () => {
    // index:9 isn't a preset variant, but index is — use the base description.
    const desc = lookupTokenDescription("index:9");
    expect(desc).toBeTruthy();
    expect(desc).toBe(lookupTokenDescription("index"));
  });

  it("uses the exact description for preset variants over the base", () => {
    // index:1 is in EXTRA_TOKENS with its own description.
    expect(lookupTokenDescription("index:1")).toBe("1-based (offset by 1)");
  });

  it("finds descriptions for end: and duration: format presets", () => {
    expect(lookupTokenDescription("end:HH:mm:ss,SSS")).toBe("00:00:03,500");
    expect(lookupTokenDescription("duration:X.SSS")).toBe("2.300");
  });

  it("returns null for unknown tokens", () => {
    expect(lookupTokenDescription("nope")).toBeNull();
  });

  it("returns null when both exact and base are missing", () => {
    expect(lookupTokenDescription("nope:format")).toBeNull();
  });
});
