import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: any[]) => invokeMock(...args) }));

const openMock = vi.fn();
const saveMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: any[]) => openMock(...args),
  save: (...args: any[]) => saveMock(...args),
}));

const joinMock = vi.fn((...parts: string[]) => parts.join("/"));
vi.mock("@tauri-apps/api/path", () => ({
  join: (...args: any[]) => joinMock(...args),
}));

import { exportCaptionsBulk } from "../index";
import type { ExportFormat, BulkExportItem } from "../index";
import type { CaptionBlock } from "../../../types/project";

// Minimal valid .cff source that parseCff accepts.
// parseCff requires "name:" and "ext:" in the header, a blank line, then the template.
const CFF_SOURCE = "name: SRT\next: srt\n\n{{count}}";

function makeFormat(): ExportFormat {
  return {
    id: "srt",
    name: "SRT",
    extension: "srt",
    formatPath: "/fmt/srt.cff",
    source: "builtin",
  };
}

function makeCaptions(): CaptionBlock[] {
  return [{ index: 1, start: 0, end: 1, lines: ["hi"] }];
}

function makeItem(name: string): BulkExportItem {
  return {
    name,
    captions: makeCaptions(),
    fps: 30,
    dropFrame: false,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  openMock.mockReset();
  saveMock.mockReset();
  joinMock.mockClear();
  joinMock.mockImplementation((...parts: string[]) => parts.join("/"));
});

describe("exportCaptionsBulk", () => {
  it("returns null when the folder picker is cancelled (no save_project invokes)", async () => {
    openMock.mockResolvedValueOnce(null);
    invokeMock.mockImplementation(async () => {
      throw new Error("invoke should not be called when picker cancels");
    });

    const result = await exportCaptionsBulk(makeFormat(), [makeItem("a")]);

    expect(result).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("dedupes three identical names to clip, clip-1, clip-2 with three save_project invokes", async () => {
    openMock.mockResolvedValueOnce("/out");
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "load_project") return CFF_SOURCE;
      if (cmd === "save_project") return undefined;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const items = [makeItem("clip"), makeItem("clip"), makeItem("clip")];
    const result = await exportCaptionsBulk(makeFormat(), items);

    expect(result).not.toBeNull();
    expect(result!.folder).toBe("/out");
    expect(result!.failed).toEqual([]);
    expect(result!.written).toEqual(["clip.srt", "clip-1.srt", "clip-2.srt"]);

    const saveCalls = invokeMock.mock.calls.filter((c) => c[0] === "save_project");
    expect(saveCalls).toHaveLength(3);
    expect(saveCalls.map((c) => (c[1] as { path: string }).path)).toEqual([
      "/out/clip.srt",
      "/out/clip-1.srt",
      "/out/clip-2.srt",
    ]);
  });

  it("records a per-item runtime error without throwing; other items still write", async () => {
    openMock.mockResolvedValueOnce("/out");
    let loadCallCount = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "load_project") {
        loadCallCount++;
        if (loadCallCount === 2) throw new Error("boom load failed");
        return CFF_SOURCE;
      }
      if (cmd === "save_project") return undefined;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const items = [makeItem("a"), makeItem("b"), makeItem("c")];
    const result = await exportCaptionsBulk(makeFormat(), items);

    expect(result).not.toBeNull();
    expect(result!.folder).toBe("/out");
    expect(result!.written).toEqual(["a.srt", "c.srt"]);
    expect(result!.failed).toHaveLength(1);
    expect(result!.failed[0].name).toBe("b");
    expect(result!.failed[0].error).toContain("boom load failed");
  });

  it("returns full success: failed empty, written length matches items, folder echoed", async () => {
    openMock.mockResolvedValueOnce("/chosen");
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "load_project") return CFF_SOURCE;
      if (cmd === "save_project") return undefined;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const items = [makeItem("one"), makeItem("two"), makeItem("three")];
    const result = await exportCaptionsBulk(makeFormat(), items);

    expect(result).not.toBeNull();
    expect(result!.folder).toBe("/chosen");
    expect(result!.failed).toEqual([]);
    expect(result!.written).toHaveLength(items.length);
    expect(result!.written).toEqual(["one.srt", "two.srt", "three.srt"]);
  });

  it("dedupes case-insensitively using each item's own casing in the suffix", async () => {
    openMock.mockResolvedValueOnce("/out");
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "load_project") return CFF_SOURCE;
      if (cmd === "save_project") return undefined;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const items = [makeItem("Clip"), makeItem("clip"), makeItem("CLIP")];
    const result = await exportCaptionsBulk(makeFormat(), items);

    expect(result).not.toBeNull();
    expect(result!.failed).toEqual([]);
    // First-seen "Clip" wins; collisions compared case-insensitively, but
    // each suffixed name uses that item's own casing.
    expect(result!.written).toEqual(["Clip.srt", "clip-1.srt", "CLIP-2.srt"]);
  });

  it("returns folder + empty written/failed when items[] is empty", async () => {
    openMock.mockResolvedValueOnce("/empty");
    invokeMock.mockImplementation(async () => {
      throw new Error("invoke should not be called when items is empty");
    });

    const result = await exportCaptionsBulk(makeFormat(), []);

    expect(result).toEqual({ folder: "/empty", written: [], failed: [] });
  });
});
