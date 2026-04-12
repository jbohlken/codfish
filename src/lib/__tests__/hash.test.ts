import { describe, it, expect } from "vitest";
import { hashContent } from "../hash";

describe("hashContent", () => {
  it("returns a 64-char lowercase hex string", async () => {
    const hash = await hashContent("hello");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", async () => {
    const a = await hashContent("test content");
    const b = await hashContent("test content");
    expect(a).toBe(b);
  });

  it("produces the same hash for CRLF and LF input", async () => {
    const lf = await hashContent("line1\nline2\nline3");
    const crlf = await hashContent("line1\r\nline2\r\nline3");
    expect(lf).toBe(crlf);
  });

  it("produces the same hash regardless of trailing whitespace", async () => {
    const clean = await hashContent("content");
    const trailing = await hashContent("content\n\n");
    const trailingSpaces = await hashContent("content   ");
    expect(clean).toBe(trailing);
    expect(clean).toBe(trailingSpaces);
  });

  it("produces different hashes for different content", async () => {
    const a = await hashContent("format A");
    const b = await hashContent("format B");
    expect(a).not.toBe(b);
  });
});
