import { describe, it, expect } from "vitest";
import {
  executeTemplate,
  parseCff,
  serializeCff,
  type FormatConfig,
} from "../builder";
import type { SerializedCaption } from "../index";

// ── Test data ────────────────────────────────────────────────────────────────

const CAPTIONS: SerializedCaption[] = [
  { index: 1, start: 0, end: 2.5, lines: ["Hello world."] },
  { index: 2, start: 3.0, end: 5.2, lines: ["This is a test."] },
  { index: 3, start: 6.0, end: 9.0, lines: ["Line one", "Line two"] },
  { index: 4, start: 10.0, end: 12.5, lines: ["Final caption."] },
];

const SRT_CFF = `name: SRT
ext: srt

{{each}}
{{index:1}}
{{start:HH:mm:ss,SSS}} --> {{end:HH:mm:ss,SSS}}
{{text}}

{{/each}}`;

const VTT_CFF = `name: WebVTT
ext: vtt

WEBVTT

{{each}}
{{index:1}}
{{start:HH:mm:ss.SSS}} --> {{end:HH:mm:ss.SSS}}
{{text}}

{{/each}}
`;

const JSON_CFF = `name: JSON
ext: json

{{json}}`;

const TXT_CFF = `name: Plain Text
ext: txt

{{each}}{{text:space}} {{/each}}`;

// ── Format file → output integration ─────────────────────────────────────────

/**
 * Simulate what runFormat does: parse a .cff file, execute its template.
 * This is the pure-logic core of export — no Tauri IPC needed.
 */
function runFormat(cffSource: string, captions: SerializedCaption[], fps = 30, dropFrame = false): string {
  const config = parseCff(cffSource);
  if (!config) throw new Error("Invalid .cff format");
  return executeTemplate(config.template, captions, fps, dropFrame);
}

describe("export integration: .cff → output", () => {
  describe("SRT", () => {
    it("produces valid SRT output", () => {
      const output = runFormat(SRT_CFF, CAPTIONS);
      const blocks = output.trim().split("\n\n");
      expect(blocks).toHaveLength(4);
    });

    it("has correct index numbering", () => {
      const output = runFormat(SRT_CFF, CAPTIONS);
      expect(output).toContain("1\n00:00:00,000");
      expect(output).toContain("2\n00:00:03,000");
      expect(output).toContain("3\n00:00:06,000");
      expect(output).toContain("4\n00:00:10,000");
    });

    it("formats timestamps with commas", () => {
      const output = runFormat(SRT_CFF, CAPTIONS);
      expect(output).toContain("00:00:00,000 --> 00:00:02,500");
      expect(output).toContain("00:00:03,000 --> 00:00:05,200");
    });

    it("preserves multi-line text", () => {
      const output = runFormat(SRT_CFF, CAPTIONS);
      expect(output).toContain("Line one\nLine two");
    });

    it("produces empty output for no captions", () => {
      const output = runFormat(SRT_CFF, []);
      expect(output.trim()).toBe("");
    });
  });

  describe("WebVTT", () => {
    it("starts with WEBVTT header", () => {
      const output = runFormat(VTT_CFF, CAPTIONS);
      expect(output).toMatch(/^WEBVTT\n/);
    });

    it("formats timestamps with dots", () => {
      const output = runFormat(VTT_CFF, CAPTIONS);
      expect(output).toContain("00:00:00.000 --> 00:00:02.500");
    });

    it("produces header-only for no captions", () => {
      const output = runFormat(VTT_CFF, []);
      expect(output).toMatch(/^WEBVTT\n/);
      // Should not contain any timestamps
      expect(output).not.toContain("-->");
    });
  });

  describe("JSON", () => {
    it("produces valid JSON array", () => {
      const output = runFormat(JSON_CFF, CAPTIONS);
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(4);
    });

    it("includes all caption fields", () => {
      const output = runFormat(JSON_CFF, CAPTIONS);
      const parsed = JSON.parse(output);
      expect(parsed[0]).toMatchObject({
        index: 1,
        start: 0,
        end: 2.5,
        lines: ["Hello world."],
      });
    });

    it("preserves multi-line captions", () => {
      const output = runFormat(JSON_CFF, CAPTIONS);
      const parsed = JSON.parse(output);
      expect(parsed[2].lines).toEqual(["Line one", "Line two"]);
    });

    it("produces empty array for no captions", () => {
      const output = runFormat(JSON_CFF, []);
      expect(JSON.parse(output)).toEqual([]);
    });
  });

  describe("Plain Text", () => {
    it("produces space-joined text", () => {
      const output = runFormat(TXT_CFF, CAPTIONS);
      expect(output).toContain("Hello world.");
      expect(output).toContain("This is a test.");
      expect(output).toContain("Line one Line two");
      expect(output).toContain("Final caption.");
    });
  });

  describe("SMPTE in format files", () => {
    const SMPTE_CFF = `name: SMPTE
ext: txt

{{each}}
{{start-smpte}} --> {{end-smpte}}
{{text}}

{{/each}}`;

    it("produces NDF timecodes at 30fps", () => {
      const output = runFormat(SMPTE_CFF, CAPTIONS, 30, false);
      expect(output).toContain("00:00:00:00 --> 00:00:02:15");
      expect(output).not.toContain(";");
    });

    it("produces DF timecodes at 29.97fps with dropFrame", () => {
      const output = runFormat(SMPTE_CFF, CAPTIONS, 29.97, true);
      expect(output).toContain(";"); // DF semicolons
    });

    it("falls back to NDF for non-DF rates even with dropFrame=true", () => {
      const output = runFormat(SMPTE_CFF, CAPTIONS, 24, true);
      expect(output).not.toContain(";");
    });
  });
});

// ── Round-trip: config → serialize → parse → execute ─────────────────────────

describe("format round-trip", () => {
  it("serialize → parse → execute produces same output as direct execute", () => {
    const config: FormatConfig = {
      name: "Custom SRT",
      extension: "srt",
      template: `{{each}}\n{{index:1}}\n{{start:HH:mm:ss,SSS}} --> {{end:HH:mm:ss,SSS}}\n{{text}}\n\n{{/each}}`,
    };

    const direct = executeTemplate(config.template, CAPTIONS);
    const roundTripped = runFormat(serializeCff(config), CAPTIONS);
    expect(roundTripped).toBe(direct);
  });

  it("preserves format metadata through round-trip", () => {
    const config: FormatConfig = {
      name: "My Format",
      extension: "ass",
      template: "{{each}}{{text}}{{/each}}",
    };
    const serialized = serializeCff(config);
    const parsed = parseCff(serialized);
    expect(parsed).toEqual(config);
  });

  it("builtin source survives round-trip", () => {
    const config: FormatConfig = {
      name: "SRT",
      extension: "srt",
      template: "{{each}}{{text}}{{/each}}",
    };
    const serialized = serializeCff(config, "builtin");
    const parsed = parseCff(serialized);
    // parseCff strips source field — it's metadata, not part of FormatConfig
    expect(parsed).toEqual(config);
    // But the source line should be present in the raw string
    expect(serialized).toContain("source: builtin");
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("export edge cases", () => {
  it("single caption produces valid SRT", () => {
    const output = runFormat(SRT_CFF, [CAPTIONS[0]]);
    expect(output).toContain("1\n00:00:00,000 --> 00:00:02,500\nHello world.");
  });

  it("caption at hour boundary", () => {
    const hourCaption: SerializedCaption[] = [
      { index: 1, start: 3599.5, end: 3601.2, lines: ["Crossing the hour"] },
    ];
    const output = runFormat(SRT_CFF, hourCaption);
    expect(output).toContain("00:59:59,500 --> 01:00:01,200");
  });

  it("very long duration", () => {
    const longCaption: SerializedCaption[] = [
      { index: 1, start: 0, end: 36000, lines: ["Ten hours in"] },
    ];
    const output = runFormat(SRT_CFF, longCaption);
    expect(output).toContain("10:00:00,000");
  });

  it("sub-frame timestamps format correctly", () => {
    const precise: SerializedCaption[] = [
      { index: 1, start: 0.001, end: 0.999, lines: ["Precise"] },
    ];
    const output = runFormat(SRT_CFF, precise);
    expect(output).toContain("00:00:00,001 --> 00:00:00,999");
  });

  it("custom format with header and footer", () => {
    const customCff = `name: Custom
ext: txt

=== START ===
Total: {{count}} captions
{{each}}
[{{index:1}}] {{start:mm:ss.SSS}}-{{end:mm:ss.SSS}}: {{text:space}}
{{/each}}
=== END ===`;

    const output = runFormat(customCff, CAPTIONS);
    expect(output).toMatch(/^=== START ===/);
    expect(output).toContain("Total: 4 captions");
    expect(output).toContain("[1] 00:00.000-00:02.500: Hello world.");
    expect(output).toContain("[3] 00:06.000-00:09.000: Line one Line two");
    expect(output).toMatch(/=== END ===$/);
  });
});
