import { describe, it, expect } from "vitest";
import {
  validateFormatConfig,
  normalizeFormatConfig,
  uniqueFormatName,
  randomFormatFilename,
} from "../validation";
import type { ExportFormat } from "../index";

// ── Test fixtures ────────────────────────────────────────────────────────────

function fmt(name: string, formatPath = `/fake/${name}.cff`): ExportFormat {
  return { id: name, name, extension: "txt", formatPath, source: "custom" };
}

const validConfig = {
  name: "My Format",
  extension: "txt",
  template: "{{each}}{{text}}{{/each}}",
};

// ── validateFormatConfig ─────────────────────────────────────────────────────

describe("validateFormatConfig", () => {
  it("returns no errors for a valid config", () => {
    const errs = validateFormatConfig(validConfig, [], null);
    expect(errs).toEqual({});
  });

  it("flags empty name as Required", () => {
    const errs = validateFormatConfig({ ...validConfig, name: "" }, [], null);
    expect(errs.name).toBe("Required");
  });

  it("flags whitespace-only name as Required", () => {
    const errs = validateFormatConfig({ ...validConfig, name: "   " }, [], null);
    expect(errs.name).toBe("Required");
  });

  it("flags empty extension as Required", () => {
    const errs = validateFormatConfig({ ...validConfig, extension: "" }, [], null);
    expect(errs.extension).toBe("Required");
  });

  it("flags whitespace-only extension as Required", () => {
    const errs = validateFormatConfig({ ...validConfig, extension: "  " }, [], null);
    expect(errs.extension).toBe("Required");
  });

  it("flags empty template as Required", () => {
    const errs = validateFormatConfig({ ...validConfig, template: "" }, [], null);
    expect(errs.template).toBe("Required");
  });

  it("flags whitespace-only template as Required", () => {
    const errs = validateFormatConfig({ ...validConfig, template: "\n\n  \n" }, [], null);
    expect(errs.template).toBe("Required");
  });

  it("returns all three errors when all fields empty", () => {
    const errs = validateFormatConfig(
      { name: "", extension: "", template: "" },
      [],
      null,
    );
    expect(errs).toEqual({
      name: "Required",
      extension: "Required",
      template: "Required",
    });
  });

  it("flags a name that collides with another format", () => {
    const formats = [fmt("SRT", "/a/srt.cff")];
    const errs = validateFormatConfig({ ...validConfig, name: "SRT" }, formats, "/a/new.cff");
    expect(errs.name).toBe("Name in use");
  });

  it("trims before comparing for collision", () => {
    const formats = [fmt("SRT", "/a/srt.cff")];
    const errs = validateFormatConfig({ ...validConfig, name: "  SRT  " }, formats, "/a/new.cff");
    expect(errs.name).toBe("Name in use");
  });

  it("excludes the current format from the duplicate check", () => {
    const formats = [fmt("SRT", "/a/srt.cff")];
    // Editing the SRT format itself should not flag its own name as duplicate.
    const errs = validateFormatConfig({ ...validConfig, name: "SRT" }, formats, "/a/srt.cff");
    expect(errs.name).toBeUndefined();
  });

  it("prefers the Required error over the duplicate error", () => {
    // Empty name can't collide (empty string isn't in any list), so Required wins.
    const formats = [fmt("SRT", "/a/srt.cff")];
    const errs = validateFormatConfig({ ...validConfig, name: "" }, formats, null);
    expect(errs.name).toBe("Required");
  });
});

// ── normalizeFormatConfig ────────────────────────────────────────────────────

describe("normalizeFormatConfig", () => {
  it("trims leading/trailing whitespace on name", () => {
    const result = normalizeFormatConfig({
      name: "  SRT  ",
      extension: "srt",
      template: "x",
    });
    expect(result.name).toBe("SRT");
  });

  it("trims leading/trailing whitespace on extension", () => {
    const result = normalizeFormatConfig({
      name: "SRT",
      extension: " srt ",
      template: "x",
    });
    expect(result.extension).toBe("srt");
  });

  it("preserves template whitespace verbatim", () => {
    const template = "  \n{{each}}\n  {{text}}\n{{/each}}\n  ";
    const result = normalizeFormatConfig({ name: "X", extension: "x", template });
    expect(result.template).toBe(template);
  });

  it("is idempotent", () => {
    const cfg = { name: "SRT", extension: "srt", template: "x" };
    expect(normalizeFormatConfig(normalizeFormatConfig(cfg))).toEqual(cfg);
  });
});

// ── uniqueFormatName ─────────────────────────────────────────────────────────

describe("uniqueFormatName", () => {
  it("returns the base name when no collision", () => {
    expect(uniqueFormatName("New format", [])).toBe("New format");
  });

  it("appends 2 on single collision", () => {
    const formats = [fmt("New format")];
    expect(uniqueFormatName("New format", formats)).toBe("New format 2");
  });

  it("skips past multiple collisions", () => {
    const formats = [fmt("New format"), fmt("New format 2"), fmt("New format 3")];
    expect(uniqueFormatName("New format", formats)).toBe("New format 4");
  });

  it("doesn't confuse substring matches", () => {
    const formats = [fmt("New format extended")];
    expect(uniqueFormatName("New format", formats)).toBe("New format");
  });
});

// ── randomFormatFilename ─────────────────────────────────────────────────────

describe("randomFormatFilename", () => {
  it("returns the first generated name when there's no collision", () => {
    const result = randomFormatFilename([], () => "user-abcdef01.cff");
    expect(result).toBe("user-abcdef01.cff");
  });

  it("retries on collision", () => {
    const formats = [fmt("a", "/fake/user-abcdef01.cff")];
    const names = ["user-abcdef01.cff", "user-99999999.cff"];
    let i = 0;
    const result = randomFormatFilename(formats, () => names[i++]);
    expect(result).toBe("user-99999999.cff");
  });

  it("handles both forward-slash and backslash paths when detecting collisions", () => {
    const formats = [
      { ...fmt("a"), formatPath: "C:\\Users\\jared\\user-abcdef01.cff" },
    ];
    const names = ["user-abcdef01.cff", "user-99999999.cff"];
    let i = 0;
    const result = randomFormatFilename(formats, () => names[i++]);
    expect(result).toBe("user-99999999.cff");
  });

  it("uses the default crypto generator when no override is supplied", () => {
    // Just verify it produces a plausibly-unique .cff filename.
    const result = randomFormatFilename([]);
    expect(result).toMatch(/^user-[0-9a-f]{8}\.cff$/);
  });
});
