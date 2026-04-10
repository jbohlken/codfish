import { describe, it, expect } from "vitest";
import {
  executeTemplate,
  formatTime,
  formatSmpte,
  parseCff,
  serializeCff,
  isBuiltinFormat,
  findInvalidTokens,
  previewTemplate,
  SAMPLE_CAPTIONS,
  SAMPLE_FPS,
  type FormatConfig,
} from "../builder";

// ── Helpers ─────────────────────────────────────────────────────────────────

const SRT_TEMPLATE = `{{#each}}
{{index:1}}
{{start:HH:mm:ss,SSS}} --> {{end:HH:mm:ss,SSS}}
{{text}}

{{/each}}`;

const VTT_TEMPLATE = `WEBVTT

{{#each}}
{{index:1}}
{{start:HH:mm:ss.SSS}} --> {{end:HH:mm:ss.SSS}}
{{text}}

{{/each}}
`;

const TXT_TEMPLATE = `{{#each}}{{text:space}} {{/each}}`;

const JSON_TEMPLATE = `{{json}}`;

function run(template: string): string {
  return executeTemplate(template, SAMPLE_CAPTIONS);
}

// ── executeTemplate ─────────────────────────────────────────────────────────

describe("executeTemplate", () => {
  it("SRT format", () => {
    const output = run(SRT_TEMPLATE);
    expect(output).toContain("1\n00:00:01,200 --> 00:00:03,500\nHello world");
    expect(output).toContain("2\n00:00:03,800 --> 00:00:05,100\nFrom the builder");
    expect(output).toContain("3\n00:00:06,000 --> 00:00:08,750\nLine one\nLine two");
  });

  it("VTT format with header", () => {
    const output = run(VTT_TEMPLATE);
    expect(output).toMatch(/^WEBVTT\n\n/);
    expect(output).toContain("00:00:01.200 --> 00:00:03.500");
  });

  it("plain text (inline #each)", () => {
    const output = run(TXT_TEMPLATE);
    expect(output).toContain("Hello world");
    expect(output).toContain("From the builder");
    expect(output).toContain("Line one Line two");
  });

  it("JSON format (no #each)", () => {
    const output = run(JSON_TEMPLATE);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].lines).toEqual(["Hello world"]);
  });

  it("header and footer with global tokens", () => {
    const template = `Total: {{count}}\n{{#each}}\n{{text}}\n{{/each}}\nDone`;
    const output = run(template);
    expect(output).toMatch(/^Total: 3\n/);
    expect(output).toMatch(/\nDone$/);
  });

  it("empty captions produces header + footer only", () => {
    const template = `START\n{{#each}}\n{{text}}\n{{/each}}\nEND`;
    const output = executeTemplate(template, []);
    expect(output).toBe("START\n\nEND");
  });

  it("no #each — renders entire template as global", () => {
    const output = executeTemplate("Count: {{count}}", SAMPLE_CAPTIONS);
    expect(output).toBe("Count: 3");
  });

  it("normalizes Windows line endings", () => {
    const template = "{{#each}}\r\n{{text}}\r\n{{/each}}";
    const output = executeTemplate(template, SAMPLE_CAPTIONS);
    expect(output).toContain("Hello world");
  });

  it("unknown tokens pass through literally", () => {
    const output = run("{{#each}}{{unknown_thing}}{{/each}}");
    expect(output).toContain("{{unknown_thing}}");
  });
});

// ── Token resolution ────────────────────────────────────────────────────────

describe("token resolution", () => {
  it("index variants", () => {
    const cases: [string, string][] = [
      ["{{index}}", "0,1,2"],
      ["{{index:0}}", "0,1,2"],
      ["{{index:1}}", "1,2,3"],
      ["{{index:100}}", "100,101,102"],
      ["{{index:-5}}", "-5,-4,-3"],
      ["{{index:1:3}}", "001,002,003"],
      ["{{index:0:2}}", "00,01,02"],
      ["{{index:100:5}}", "00100,00101,00102"],
    ];
    for (const [token, expected] of cases) {
      const output = run(`{{#each}}${token},{{/each}}`);
      // Trim trailing comma from last iteration
      expect(output.replace(/,$/, ""), `token ${token}`).toBe(expected);
    }
  });

  it("raw start/end/duration", () => {
    const output = run("{{#each}}{{start}}-{{end}}={{duration}},{{/each}}");
    expect(output).toContain("1.2-3.5=");
  });

  it("text and text:space", () => {
    const output = run("{{#each}}{{text:space}}|{{/each}}");
    expect(output).toContain("Line one Line two|");
  });

  it("count", () => {
    const output = run("{{count}} captions");
    expect(output).toBe("3 captions");
  });

  it("json", () => {
    const output = run("{{json}}");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(3);
  });

  it("per-caption tokens return empty in global context", () => {
    const output = run("{{start}}{{text}}");
    expect(output).toBe("");
  });
});

// ── formatTime ──────────────────────────────────────────────────────────────

describe("formatTime", () => {
  it("SRT: HH:mm:ss,SSS", () => {
    expect(formatTime(1.2, "HH:mm:ss,SSS")).toBe("00:00:01,200");
    expect(formatTime(3661.5, "HH:mm:ss,SSS")).toBe("01:01:01,500");
  });

  it("VTT: HH:mm:ss.SSS", () => {
    expect(formatTime(1.2, "HH:mm:ss.SSS")).toBe("00:00:01.200");
  });

  it("whole-second: HH:mm:ss", () => {
    expect(formatTime(1.2, "HH:mm:ss")).toBe("00:00:01");
  });

  it("unpadded: H:m:s", () => {
    expect(formatTime(3661.5, "H:m:s.SSS")).toBe("1:1:1.500");
  });

  it("short: mm:ss.SSS", () => {
    expect(formatTime(1.2, "mm:ss.SSS")).toBe("00:01.200");
  });

  it("S (deciseconds)", () => {
    expect(formatTime(1.2, "ss.S")).toBe("01.2");
  });

  it("SS (centiseconds)", () => {
    expect(formatTime(1.2, "ss.SS")).toBe("01.20");
  });

  it("X (total seconds)", () => {
    expect(formatTime(65.5, "X")).toBe("65");
  });

  it("X.SSS (total seconds with ms)", () => {
    expect(formatTime(1.2, "X.SSS")).toBe("1.200");
    expect(formatTime(3661.5, "X.SSS")).toBe("3661.500");
  });

  it("X.SS (total seconds with centiseconds)", () => {
    expect(formatTime(1.2, "X.SS")).toBe("1.20");
  });

  it("X.S (total seconds with deciseconds)", () => {
    expect(formatTime(1.2, "X.S")).toBe("1.2");
  });

  it("literal separators pass through", () => {
    expect(formatTime(1.2, "HH-mm-ss")).toBe("00-00-01");
  });

  it("> 99 hours", () => {
    expect(formatTime(360000.123, "HH:mm:ss.SSS")).toBe("100:00:00.123");
  });

  it("exact zero", () => {
    expect(formatTime(0, "HH:mm:ss.SSS")).toBe("00:00:00.000");
    expect(formatTime(0, "X.SSS")).toBe("0.000");
  });

  it("ss is mod 60", () => {
    expect(formatTime(65.5, "ss")).toBe("05");
  });
});

// ── Truncation ──────────────────────────────────────────────────────────────

describe("truncation rules", () => {
  it("SSS truncates, does not round", () => {
    expect(formatTime(0.9999, "ss.SSS")).toBe("00.999");
  });

  it("SS truncates, does not round", () => {
    expect(formatTime(0.999, "ss.SS")).toBe("00.99");
  });

  it("S truncates, does not round", () => {
    expect(formatTime(0.95, "ss.S")).toBe("00.9");
  });

  it("X truncates total seconds", () => {
    expect(formatTime(1.999, "X")).toBe("1");
  });

  it("no carry from fractional into seconds", () => {
    expect(formatTime(59.999, "HH:mm:ss,SSS")).toBe("00:00:59,999");
  });
});

// ── parseCff / serializeCff ─────────────────────────────────────────────────

describe("parseCff", () => {
  it("parses a valid .cff file", () => {
    const source = `name: SRT\next: srt\n\n${SRT_TEMPLATE}`;
    const config = parseCff(source);
    expect(config).toEqual({ name: "SRT", extension: "srt", template: SRT_TEMPLATE });
  });

  it("parses with source: builtin", () => {
    const source = `name: SRT\next: srt\nsource: builtin\n\n${SRT_TEMPLATE}`;
    const config = parseCff(source);
    expect(config).toEqual({ name: "SRT", extension: "srt", template: SRT_TEMPLATE });
  });

  it("returns null for missing blank line", () => {
    expect(parseCff("name: SRT\next: srt")).toBeNull();
  });

  it("returns null for missing name", () => {
    expect(parseCff("ext: srt\n\ntemplate")).toBeNull();
  });

  it("returns null for missing ext", () => {
    expect(parseCff("name: SRT\n\ntemplate")).toBeNull();
  });

  it("handles Windows line endings", () => {
    const source = "name: SRT\r\next: srt\r\n\r\ntemplate body";
    const config = parseCff(source);
    expect(config).toEqual({ name: "SRT", extension: "srt", template: "template body" });
  });
});

describe("serializeCff", () => {
  it("produces valid .cff content", () => {
    const config: FormatConfig = { name: "Test", extension: "txt", template: "{{text}}" };
    const cff = serializeCff(config);
    expect(cff).toBe("name: Test\next: txt\n\n{{text}}");
  });

  it("includes source when specified", () => {
    const config: FormatConfig = { name: "Test", extension: "txt", template: "{{text}}" };
    const cff = serializeCff(config, "builtin");
    expect(cff).toBe("name: Test\next: txt\nsource: builtin\n\n{{text}}");
  });
});

describe("round-trip: config → cff → parse → config", () => {
  it("recovers the original config", () => {
    const config: FormatConfig = { name: "My Format", extension: "srt", template: SRT_TEMPLATE };
    const cff = serializeCff(config);
    const parsed = parseCff(cff);
    expect(parsed).toEqual(config);
  });
});

// ── isBuiltinFormat ─────────────────────────────────────────────────────────

describe("isBuiltinFormat", () => {
  it("detects builtin source", () => {
    expect(isBuiltinFormat("name: SRT\next: srt\nsource: builtin\n\ntemplate")).toBe(true);
  });

  it("rejects custom formats", () => {
    expect(isBuiltinFormat("name: Custom\next: txt\n\ntemplate")).toBe(false);
  });
});

// ── Token validation ────────────────────────────────────────────────────────

describe("findInvalidTokens", () => {
  it("valid base tokens", () => {
    const valid = ["{{start}}", "{{end}}", "{{duration}}", "{{text}}", "{{text:space}}",
      "{{smpte-start}}", "{{smpte-end}}", "{{smpte-df-start}}", "{{smpte-df-end}}",
      "{{count}}", "{{json}}",
      "{{index}}", "{{#each}}", "{{/each}}"];
    for (const token of valid) {
      expect(findInvalidTokens(token), `${token} should be valid`).toEqual([]);
    }
  });

  it("valid parameterized tokens", () => {
    const valid = ["{{index:1}}", "{{index:-5}}", "{{index:1:3}}",
      "{{start:HH:mm:ss.SSS}}", "{{end:HH:mm:ss,SSS}}", "{{duration:X.SS}}",
      "{{start:H:m:s}}", "{{start:X}}"];
    for (const token of valid) {
      expect(findInvalidTokens(token), `${token} should be valid`).toEqual([]);
    }
  });

  it("invalid index params", () => {
    const invalid = ["{{index:}}", "{{index:abc}}", "{{index:1:0}}", "{{index:1:abc}}"];
    for (const token of invalid) {
      expect(findInvalidTokens(token), `${token} should be invalid`).toContain(token);
    }
  });

  it("invalid time formats", () => {
    const invalid = ["{{start:}}", "{{start:xyz}}", "{{start:HH:mm:ss txt}}"];
    for (const token of invalid) {
      expect(findInvalidTokens(token), `${token} should be invalid`).toContain(token);
    }
  });

  it("unknown tokens", () => {
    expect(findInvalidTokens("{{foo}}")).toEqual(["{{foo}}"]);
    expect(findInvalidTokens("{{bar:baz}}")).toEqual(["{{bar:baz}}"]);
  });
});

// ── SMPTE timecode ──────────────────────────────────────────────────────────

describe("formatSmpte", () => {
  // NDF tests
  it("NDF at 29.97fps", () => {
    expect(formatSmpte(1.2, 29.97, false)).toBe("00:00:01:05");
  });

  it("NDF at 24fps", () => {
    expect(formatSmpte(1.2, 24, false)).toBe("00:00:01:04");
  });

  it("NDF at 25fps", () => {
    expect(formatSmpte(0, 25, false)).toBe("00:00:00:00");
  });

  it("NDF rolls over seconds", () => {
    // 61.5 seconds at 24fps → 00:01:01:12
    expect(formatSmpte(61.5, 24, false)).toBe("00:01:01:12");
  });

  it("NDF rolls over hours", () => {
    expect(formatSmpte(3661.0, 24, false)).toBe("01:01:01:00");
  });

  // DF tests — 29.97fps
  it("DF at 29.97fps — zero", () => {
    expect(formatSmpte(0, 29.97, true)).toBe("00:00:00;00");
  });

  it("DF at 29.97fps — basic", () => {
    expect(formatSmpte(1.2, 29.97, true)).toBe("00:00:01;05");
  });

  it("DF skips frames 0-1 at minute boundary", () => {
    // Frame 1800 at 29.97fps = first frame of minute 1
    // In DF, minute 1 starts at display frame 2 (0 and 1 are skipped)
    const t = 1800 / 29.97; // exactly frame 1800
    const result = formatSmpte(t, 29.97, true);
    expect(result).toBe("00:01:00;02");
  });

  it("DF does NOT skip at 10-minute boundaries", () => {
    // Frame 17982 = first frame of the next 10-min block
    // At 10-min boundaries, frames 0 and 1 are NOT skipped
    const t = 17982 / 29.97;
    const result = formatSmpte(t, 29.97, true);
    expect(result).toBe("00:10:00;00");
  });

  it("DF falls back to NDF for 24fps", () => {
    const ndf = formatSmpte(1.2, 24, false);
    const dfFallback = formatSmpte(1.2, 24, true);
    expect(dfFallback).toBe(ndf);
    expect(dfFallback).not.toContain(";"); // should use : not ;
  });

  it("DF falls back to NDF for 25fps", () => {
    expect(formatSmpte(1.2, 25, true)).toBe(formatSmpte(1.2, 25, false));
  });

  it("DF at 59.94fps", () => {
    const result = formatSmpte(1.2, 59.94, true);
    expect(result).toContain(";");
    // 1.2s * 59.94 ≈ 71 frames → 00:00:01;11
    expect(result).toBe("00:00:01;11");
  });
});

describe("SMPTE tokens in template", () => {
  const run = (tmpl: string, fps = SAMPLE_FPS) =>
    executeTemplate(tmpl, SAMPLE_CAPTIONS, fps);

  it("smpte-start and smpte-end (NDF)", () => {
    const output = run("{{#each}}{{smpte-start}} {{smpte-end}},{{/each}}");
    expect(output).toContain("00:00:01:05 00:00:03:14");
  });

  it("smpte-df-start (DF at 29.97)", () => {
    const output = run("{{#each}}{{smpte-df-start}},{{/each}}", 29.97);
    expect(output).toContain(";"); // DF uses semicolon
  });

  it("smpte-df falls back to NDF at 24fps", () => {
    const output = run("{{#each}}{{smpte-df-start}},{{/each}}", 24);
    expect(output).not.toContain(";"); // NDF uses colon
  });

  it("smpte tokens are per-caption (empty outside #each)", () => {
    const output = run("before:{{smpte-start}}:after");
    expect(output).toBe("before::after");
  });
});

// ── previewTemplate ─────────────────────────────────────────────────────────

describe("previewTemplate", () => {
  it("produces output from FormatConfig", () => {
    const config: FormatConfig = { name: "SRT", extension: "srt", template: SRT_TEMPLATE };
    const output = previewTemplate(config);
    expect(output).toContain("00:00:01,200");
  });

  it("returns error string for broken template", () => {
    const config: FormatConfig = { name: "Bad", extension: "txt", template: "" };
    const output = previewTemplate(config);
    expect(typeof output).toBe("string");
  });
});
