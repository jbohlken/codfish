import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────
// Mock only runBatchGeneration; keep the computeds (eligibleMediaIds,
// allTranscribableMediaIds, captionedMedia) as the REAL ones so we can drive
// them by setting project.value.

const runBatchMock = vi.fn<(...args: any[]) => Promise<void>>(async () => {});
vi.mock("../batch", async () => {
  const actual = await vi.importActual<typeof import("../batch")>("../batch");
  return {
    ...actual,
    runBatchGeneration: (...args: any[]) => runBatchMock(...args),
  };
});

const exportCaptionsMock = vi.fn<(...args: any[]) => Promise<void>>(async () => {});
const exportCaptionsBulkMock = vi.fn<(...args: any[]) => Promise<any>>(async () => null);
vi.mock("../export", () => ({
  exportCaptions: (...a: any[]) => exportCaptionsMock(...a),
  exportCaptionsBulk: (...a: any[]) => exportCaptionsBulkMock(...a),
}));

const showErrorMock = vi.fn<(...args: any[]) => void>();
vi.mock("../../components/ErrorModal", () => ({
  showError: (...a: any[]) => showErrorMock(...a),
}));

const showNoticeMock = vi.fn<(...args: any[]) => void>();
vi.mock("../../components/NoticeModal", () => ({
  showNotice: (...a: any[]) => showNoticeMock(...a),
}));

const confirmMock = vi.fn<(...args: any[]) => Promise<"save" | "discard" | "cancel">>(
  async () => "save",
);
vi.mock("../../components/UnsavedChanges", () => ({
  confirmUnsavedChanges: (...a: any[]) => confirmMock(...a),
}));

// ── SUT + signals (import AFTER mocks) ─────────────────────────────────────

import {
  generateSelectedMedia,
  generateMissingMedia,
  regenerateAllMedia,
  exportSelectedMedia,
  exportAllMedia,
} from "../actions";
import {
  project,
  selectedMediaId,
  exportFormats,
  selectedExportFormat,
  profiles,
  selectedProfile,
} from "../../store/app";
import type {
  CodProject,
  MediaItem,
  CaptionBlock,
} from "../../types/project";
import type { CaptionProfile } from "../../types/profile";
import type { ExportFormat } from "../export";

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeCaption(index: number): CaptionBlock {
  return { index, start: index, end: index + 1, lines: ["x"] };
}

function makeMedia(over: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "m1",
    name: "clip",
    path: "/tmp/clip.mp4",
    fps: 30,
    captions: [],
    exports: [],
    ...over,
  };
}

function makeProject(media: MediaItem[]): CodProject {
  return {
    version: 1,
    name: "p",
    transcriptionModel: "base",
    language: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    media,
  };
}

function makeProfile(over: Partial<CaptionProfile["timing"]> = {}): CaptionProfile {
  return {
    id: "test",
    name: "Test",
    description: "",
    builtIn: false,
    timing: {
      minDuration: { value: 0.5, strict: true, unit: "s" },
      maxDuration: { value: 6, strict: true, unit: "s" },
      maxCps: { value: 20, strict: false },
      extendToFill: false,
      extendToFillMax: 0.5,
      gapCloseThreshold: 0.5,
      minGapEnabled: true,
      minGapSeconds: { value: 0.4, strict: true, unit: "s" },
      defaultFps: 24,
      ...over,
    },
    formatting: {
      maxCharsPerLine: { value: 42, strict: false },
      maxLines: { value: 2, strict: true },
    },
    merge: { enabled: false, phraseBreakGap: 0.7, minSegmentWords: 3, mergeGapThreshold: 0.5 },
  };
}

function makeFormat(over: Partial<ExportFormat> = {}): ExportFormat {
  return {
    id: "SRT",
    name: "SRT",
    extension: "srt",
    formatPath: "/tmp/srt.cff",
    source: "builtin",
    ...over,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  project.value = null;
  selectedMediaId.value = null;
  exportFormats.value = [];
  selectedExportFormat.value = "SRT";
  profiles.value = [makeProfile()];
  selectedProfile.value = "Test";

  runBatchMock.mockReset();
  runBatchMock.mockImplementation(async () => {});
  exportCaptionsMock.mockReset();
  exportCaptionsMock.mockImplementation(async () => {});
  exportCaptionsBulkMock.mockReset();
  exportCaptionsBulkMock.mockImplementation(async () => null as any);
  showErrorMock.mockReset();
  showNoticeMock.mockReset();
  confirmMock.mockReset();
  confirmMock.mockImplementation(async () => "save");
});

// ── generateSelectedMedia ──────────────────────────────────────────────────

describe("generateSelectedMedia", () => {
  it("no selection → no-op", async () => {
    project.value = makeProject([makeMedia()]);
    selectedMediaId.value = null;

    await generateSelectedMedia();

    expect(runBatchMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("fresh media → runBatch called with [id]; confirm NOT called", async () => {
    const m = makeMedia({ id: "abc", captions: [] });
    project.value = makeProject([m]);
    selectedMediaId.value = "abc";

    await generateSelectedMedia();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(runBatchMock).toHaveBeenCalledOnce();
    expect(runBatchMock).toHaveBeenCalledWith(["abc"]);
  });

  it("with captions: confirm options match; cancel → runBatch NOT called", async () => {
    const m = makeMedia({ id: "abc", captions: [makeCaption(1)] });
    project.value = makeProject([m]);
    selectedMediaId.value = "abc";
    confirmMock.mockResolvedValue("cancel");

    await generateSelectedMedia();

    expect(confirmMock).toHaveBeenCalledOnce();
    const [, options] = confirmMock.mock.calls[0] as [string, any];
    expect(options).toEqual({
      title: "Regenerate captions?",
      hideDiscard: true,
      confirmLabel: "Regenerate",
    });
    expect(runBatchMock).not.toHaveBeenCalled();
  });

  it("with captions: save → runBatch called with [id]", async () => {
    const m = makeMedia({ id: "abc", captions: [makeCaption(1)] });
    project.value = makeProject([m]);
    selectedMediaId.value = "abc";
    confirmMock.mockResolvedValue("save");

    await generateSelectedMedia();

    expect(confirmMock).toHaveBeenCalledOnce();
    expect(runBatchMock).toHaveBeenCalledWith(["abc"]);
  });

  it("confirm message body contains the selected media's name", async () => {
    const m = makeMedia({ id: "abc", name: "MyClip", captions: [makeCaption(1)] });
    project.value = makeProject([m]);
    selectedMediaId.value = "abc";
    confirmMock.mockResolvedValue("cancel");

    await generateSelectedMedia();

    const [message] = confirmMock.mock.calls[0] as [string, any];
    expect(message).toContain("MyClip");
  });
});

// ── generateMissingMedia ───────────────────────────────────────────────────

describe("generateMissingMedia", () => {
  it("empty eligible → no-op", async () => {
    // Project with one media that already has captions → not eligible.
    project.value = makeProject([
      makeMedia({ id: "done", captions: [makeCaption(1)] }),
    ]);

    await generateMissingMedia();

    expect(runBatchMock).not.toHaveBeenCalled();
  });

  it("runBatch called with eligible IDs in order", async () => {
    project.value = makeProject([
      makeMedia({ id: "a", captions: [] }),
      makeMedia({ id: "b", captions: [makeCaption(1)] }),     // skipped (already captioned)
      makeMedia({ id: "c", captions: [], hasAudio: false }),  // skipped (no audio)
      makeMedia({ id: "d", captions: [] }),
    ]);

    await generateMissingMedia();

    expect(runBatchMock).toHaveBeenCalledOnce();
    expect(runBatchMock).toHaveBeenCalledWith(["a", "d"]);
  });
});

// ── regenerateAllMedia ─────────────────────────────────────────────────────

describe("regenerateAllMedia", () => {
  it("empty transcribable → no-op (confirm not called)", async () => {
    project.value = makeProject([
      makeMedia({ id: "x", hasAudio: false }),
    ]);

    await regenerateAllMedia();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(runBatchMock).not.toHaveBeenCalled();
  });

  it("cancel → runBatch not called", async () => {
    project.value = makeProject([makeMedia({ id: "a" })]);
    confirmMock.mockResolvedValue("cancel");

    await regenerateAllMedia();

    expect(confirmMock).toHaveBeenCalledOnce();
    expect(runBatchMock).not.toHaveBeenCalled();
  });

  it("save → confirm options match; runBatch with all transcribable IDs", async () => {
    project.value = makeProject([
      makeMedia({ id: "a" }),
      makeMedia({ id: "b", hasAudio: false }), // excluded
      makeMedia({ id: "c", captions: [makeCaption(1)] }),
    ]);
    confirmMock.mockResolvedValue("save");

    await regenerateAllMedia();

    expect(confirmMock).toHaveBeenCalledOnce();
    const [, options] = confirmMock.mock.calls[0] as [string, any];
    expect(options.title).toBe("Regenerate everything?");
    expect(options.confirmLabel).toBe("Regenerate everything");
    expect(runBatchMock).toHaveBeenCalledWith(["a", "c"]);
  });

  it("singular: 1 file → confirm message contains '1 media file' (no s)", async () => {
    project.value = makeProject([makeMedia({ id: "only" })]);
    confirmMock.mockResolvedValue("cancel");

    await regenerateAllMedia();

    const [message] = confirmMock.mock.calls[0] as [string, any];
    expect(message).toContain("1 media file");
    expect(message).not.toContain("1 media files");
  });

  it("plural: 2+ files → confirm message contains 'N media files'", async () => {
    project.value = makeProject([
      makeMedia({ id: "a" }),
      makeMedia({ id: "b" }),
      makeMedia({ id: "c" }),
    ]);
    confirmMock.mockResolvedValue("cancel");

    await regenerateAllMedia();

    const [message] = confirmMock.mock.calls[0] as [string, any];
    expect(message).toContain("3 media files");
  });
});

// ── exportSelectedMedia ────────────────────────────────────────────────────

describe("exportSelectedMedia", () => {
  it("no selection → no-op", async () => {
    project.value = makeProject([makeMedia()]);
    selectedMediaId.value = null;
    exportFormats.value = [makeFormat()];

    await exportSelectedMedia();

    expect(exportCaptionsMock).not.toHaveBeenCalled();
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("no captions → no-op", async () => {
    const m = makeMedia({ id: "a", captions: [] });
    project.value = makeProject([m]);
    selectedMediaId.value = "a";
    exportFormats.value = [makeFormat()];

    await exportSelectedMedia();

    expect(exportCaptionsMock).not.toHaveBeenCalled();
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("no format resolved → showError 'No export format selected.'", async () => {
    const m = makeMedia({ id: "a", captions: [makeCaption(1)] });
    project.value = makeProject([m]);
    selectedMediaId.value = "a";
    exportFormats.value = []; // resolveFormat() returns null

    await exportSelectedMedia();

    expect(showErrorMock).toHaveBeenCalledWith("No export format selected.");
    expect(exportCaptionsMock).not.toHaveBeenCalled();
  });

  it("exportCaptions throws → showError called with String(e)", async () => {
    const m = makeMedia({ id: "a", captions: [makeCaption(1)] });
    project.value = makeProject([m]);
    selectedMediaId.value = "a";
    exportFormats.value = [makeFormat()];
    exportCaptionsMock.mockRejectedValueOnce(new Error("disk full"));

    await exportSelectedMedia();

    expect(showErrorMock).toHaveBeenCalledOnce();
    expect(showErrorMock).toHaveBeenCalledWith(String(new Error("disk full")));
  });

  it("fps fallback: media.fps=null + profile.timing.defaultFps=24 → exportCaptions called with fps=24", async () => {
    const m = makeMedia({ id: "a", fps: null, captions: [makeCaption(1)] });
    project.value = makeProject([m]);
    selectedMediaId.value = "a";
    exportFormats.value = [makeFormat()];

    await exportSelectedMedia();

    expect(exportCaptionsMock).toHaveBeenCalledOnce();
    // exportCaptions(format, captions, name, fps, dropFrame)
    const args = exportCaptionsMock.mock.calls[0] as unknown as [
      ExportFormat,
      CaptionBlock[],
      string,
      number,
      boolean,
    ];
    expect(args[3]).toBe(24);
  });
});

// ── exportAllMedia ─────────────────────────────────────────────────────────

describe("exportAllMedia", () => {
  it("no captioned → no-op", async () => {
    project.value = makeProject([makeMedia({ id: "a", captions: [] })]);
    exportFormats.value = [makeFormat()];

    await exportAllMedia();

    expect(exportCaptionsBulkMock).not.toHaveBeenCalled();
    expect(showErrorMock).not.toHaveBeenCalled();
    expect(showNoticeMock).not.toHaveBeenCalled();
  });

  it("no format → showError 'No export format selected.'", async () => {
    project.value = makeProject([
      makeMedia({ id: "a", captions: [makeCaption(1)] }),
    ]);
    exportFormats.value = [];

    await exportAllMedia();

    expect(showErrorMock).toHaveBeenCalledWith("No export format selected.");
    expect(exportCaptionsBulkMock).not.toHaveBeenCalled();
  });

  it("exportCaptionsBulk returns null → neither showNotice NOR showError called", async () => {
    project.value = makeProject([
      makeMedia({ id: "a", captions: [makeCaption(1)] }),
    ]);
    exportFormats.value = [makeFormat()];
    exportCaptionsBulkMock.mockResolvedValueOnce(null as any);

    await exportAllMedia();

    expect(exportCaptionsBulkMock).toHaveBeenCalledOnce();
    expect(showNoticeMock).not.toHaveBeenCalled();
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("full success → showNotice 'Export complete' with body containing count and folder", async () => {
    project.value = makeProject([
      makeMedia({ id: "a", name: "one", captions: [makeCaption(1)] }),
      makeMedia({ id: "b", name: "two", captions: [makeCaption(1)] }),
    ]);
    exportFormats.value = [makeFormat()];
    exportCaptionsBulkMock.mockResolvedValueOnce({
      folder: "/tmp/out",
      written: ["one.srt", "two.srt"],
      failed: [],
    } as any);

    await exportAllMedia();

    expect(showNoticeMock).toHaveBeenCalledOnce();
    const [title, body] = showNoticeMock.mock.calls[0] as [string, string];
    expect(title).toBe("Export complete");
    expect(body).toContain("2");
    expect(body).toContain("/tmp/out");
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("partial failure → showError with summary + lines; showNotice NOT called", async () => {
    project.value = makeProject([
      makeMedia({ id: "a", name: "one", captions: [makeCaption(1)] }),
      makeMedia({ id: "b", name: "two", captions: [makeCaption(1)] }),
    ]);
    exportFormats.value = [makeFormat()];
    exportCaptionsBulkMock.mockResolvedValueOnce({
      folder: "/tmp/out",
      written: ["one.srt"],
      failed: [{ name: "two", error: "boom" }],
    } as any);

    await exportAllMedia();

    expect(showNoticeMock).not.toHaveBeenCalled();
    expect(showErrorMock).toHaveBeenCalledOnce();
    const [msg] = showErrorMock.mock.calls[0] as [string];
    expect(msg).toContain("Exported 1 of 2 file(s).");
    expect(msg).toContain("• two: boom");
  });

  it("REGRESSION: success path never calls confirmUnsavedChanges", async () => {
    project.value = makeProject([
      makeMedia({ id: "a", name: "one", captions: [makeCaption(1)] }),
    ]);
    exportFormats.value = [makeFormat()];
    exportCaptionsBulkMock.mockResolvedValueOnce({
      folder: "/tmp/out",
      written: ["one.srt"],
      failed: [],
    } as any);

    await exportAllMedia();

    expect(confirmMock).not.toHaveBeenCalled();
  });
});
