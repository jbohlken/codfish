import { describe, it, expect, beforeEach, vi } from "vitest";

const showErrorMock = vi.fn();
vi.mock("../../../components/ErrorModal", () => ({ showError: (...args: any[]) => showErrorMock(...args) }));
vi.mock("../../../components/UnsavedChanges", () => ({ confirmUnsavedChanges: vi.fn() }));
vi.mock("../../recovery", () => ({ clearRecovery: vi.fn(async () => {}) }));
vi.mock("../../recent", () => ({ addRecent: vi.fn(async () => {}), loadRecent: vi.fn(async () => {}) }));

const listFormatsMock = vi.fn();
const loadFormatSourceMock = vi.fn();
vi.mock("../../export", () => ({
  listFormats: (...args: any[]) => listFormatsMock(...args),
  loadFormatSource: (...args: any[]) => loadFormatSourceMock(...args),
}));

const hashContentMock = vi.fn();
vi.mock("../../hash", () => ({
  hashContent: (...args: any[]) => hashContentMock(...args),
}));

import { checkFormatCompatibility } from "../index";
import { selectedExportFormat } from "../../../store/app";
import type { CodProject } from "../../../types/project";

function makeProject(overrides?: Partial<CodProject>): CodProject {
  return {
    version: 1,
    name: "test",
    transcriptionModel: "base",
    language: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    media: [],
    ...overrides,
  };
}

describe("checkFormatCompatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectedExportFormat.value = "SRT";
  });

  it("defaults selection to SRT when project has no exportFormatName", async () => {
    listFormatsMock.mockResolvedValue([
      { name: "SRT", formatPath: "/path/srt.cff", source: "builtin" },
      { name: "VTT", formatPath: "/path/vtt.cff", source: "builtin" },
    ]);

    await checkFormatCompatibility(makeProject());

    expect(selectedExportFormat.value).toBe("SRT");
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("defaults to first available format when SRT is not installed", async () => {
    listFormatsMock.mockResolvedValue([
      { name: "VTT", formatPath: "/path/vtt.cff", source: "builtin" },
    ]);

    await checkFormatCompatibility(makeProject());

    expect(selectedExportFormat.value).toBe("VTT");
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("shows error and falls back when format is not installed", async () => {
    listFormatsMock.mockResolvedValue([
      { name: "SRT", formatPath: "/path/srt.cff", source: "builtin" },
    ]);

    await checkFormatCompatibility(makeProject({
      exportFormatName: "Custom XML",
      exportFormatHash: "abc123",
    }));

    expect(selectedExportFormat.value).toBe("SRT");
    expect(showErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Custom XML"),
    );
    expect(showErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("isn't installed"),
    );
  });

  it("selects format and shows error when hash differs", async () => {
    listFormatsMock.mockResolvedValue([
      { name: "SRT", formatPath: "/path/srt.cff", source: "builtin" },
    ]);
    loadFormatSourceMock.mockResolvedValue("name: SRT\next: srt\n\n{{each}}...");
    hashContentMock.mockResolvedValue("different_hash");

    await checkFormatCompatibility(makeProject({
      exportFormatName: "SRT",
      exportFormatHash: "original_hash",
    }));

    expect(selectedExportFormat.value).toBe("SRT");
    expect(showErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("differs"),
    );
  });

  it("selects format silently when hash matches", async () => {
    listFormatsMock.mockResolvedValue([
      { name: "VTT", formatPath: "/path/vtt.cff", source: "builtin" },
    ]);
    loadFormatSourceMock.mockResolvedValue("name: VTT\next: vtt\n\nWEBVTT...");
    hashContentMock.mockResolvedValue("matching_hash");

    await checkFormatCompatibility(makeProject({
      exportFormatName: "VTT",
      exportFormatHash: "matching_hash",
    }));

    expect(selectedExportFormat.value).toBe("VTT");
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("selects format and skips hash check when project has no exportFormatHash", async () => {
    listFormatsMock.mockResolvedValue([
      { name: "SRT", formatPath: "/path/srt.cff", source: "builtin" },
    ]);

    await checkFormatCompatibility(makeProject({
      exportFormatName: "SRT",
    }));

    expect(selectedExportFormat.value).toBe("SRT");
    expect(loadFormatSourceMock).not.toHaveBeenCalled();
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("does not throw when listFormats fails", async () => {
    listFormatsMock.mockRejectedValue(new Error("disk error"));

    await expect(
      checkFormatCompatibility(makeProject({
        exportFormatName: "SRT",
        exportFormatHash: "abc",
      })),
    ).resolves.toBeUndefined();

    expect(showErrorMock).not.toHaveBeenCalled();
  });
});
