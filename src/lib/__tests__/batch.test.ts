import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks (declared before importing the SUT) ───────────────────────────────

const transcribeMediaMock = vi.fn();
vi.mock("../transcription", () => ({
  transcribeMedia: (...args: any[]) => transcribeMediaMock(...args),
}));

const runPipelineMock = vi.fn();
vi.mock("../pipeline", () => ({
  runPipeline: (...args: any[]) => runPipelineMock(...args),
}));

const fileExistsMock = vi.fn();
vi.mock("../project", () => ({
  fileExists: (...args: any[]) => fileExistsMock(...args),
}));

const showErrorMock = vi.fn();
vi.mock("../../components/ErrorModal", () => ({
  showError: (...args: any[]) => showErrorMock(...args),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  runBatchGeneration,
  cancelBatch,
  eligibleMediaIds,
  allTranscribableMediaIds,
  captionedMedia,
  captionedMediaCount,
} from "../batch";
import * as storeModule from "../../store/app";
import {
  project,
  isDirty,
  batchState,
  batchProgress,
  batchCancelRequested,
  profiles,
  selectedProfile,
  resetHistory,
} from "../../store/app";
import type { CodProject, MediaItem, CaptionBlock } from "../../types/project";
import type { CaptionProfile } from "../../types/profile";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeProfile(): CaptionProfile {
  return {
    id: "p1",
    name: "Codfish",
    description: "",
    builtIn: true,
    timing: {
      minDuration: { value: 1, strict: false, unit: "s" },
      maxDuration: { value: 7, strict: false, unit: "s" },
      maxCps: { value: 20, strict: false },
      extendToFill: false,
      extendToFillMax: 2,
      gapCloseThreshold: 0.2,
      minGapEnabled: false,
      minGapSeconds: { value: 0.083, strict: false, unit: "s" },
      defaultFps: 30,
    },
    formatting: {
      maxCharsPerLine: { value: 42, strict: false },
      maxLines: { value: 2, strict: false },
    },
    merge: {
      enabled: true,
      phraseBreakGap: 0.5,
      minSegmentWords: 2,
      mergeGapThreshold: 0.4,
    },
  };
}

interface MakeMediaOpts {
  id?: string;
  name?: string;
  path?: string;
  hasAudio?: boolean;
  captions?: CaptionBlock[];
}

function makeMedia(opts: MakeMediaOpts = {}): MediaItem {
  return {
    id: opts.id ?? "m1",
    name: opts.name ?? "clip.mp4",
    path: opts.path ?? "/tmp/clip.mp4",
    fps: 30,
    ...(opts.hasAudio !== undefined ? { hasAudio: opts.hasAudio } : {}),
    captions: opts.captions ?? [],
    exports: [],
  };
}

function makeProject(media: MediaItem[] = [], language = ""): CodProject {
  return {
    version: 1,
    name: "t",
    transcriptionModel: "base",
    language,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    media,
  };
}

function makeCaption(index = 1): CaptionBlock {
  return { index, start: 0, end: 1, lines: ["hi"] };
}

const defaultTranscribeResult = {
  words: [{ text: "hi", start: 0, end: 0.5, confidence: 1 }],
  detectedLanguage: "en",
  alignmentDegraded: false,
};

const defaultPipelineResult = {
  captions: [{ index: 1, start: 0, end: 1, lines: ["hi"] }],
  report: { warnings: [] },
};

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  project.value = null;
  isDirty.value = false;
  batchState.value = null;
  batchProgress.value = null;
  batchCancelRequested.value = false;
  profiles.value = [makeProfile()];
  selectedProfile.value = "Codfish";
  resetHistory();
  transcribeMediaMock.mockReset();
  runPipelineMock.mockReset();
  fileExistsMock.mockReset();
  showErrorMock.mockReset();
  transcribeMediaMock.mockResolvedValue(defaultTranscribeResult);
  runPipelineMock.mockReturnValue(defaultPipelineResult);
  fileExistsMock.mockResolvedValue(true);
});

// ── Computed signals ────────────────────────────────────────────────────────

describe("eligibleMediaIds", () => {
  it("null project → []", () => {
    project.value = null;
    expect(eligibleMediaIds.value).toEqual([]);
  });

  it("empty media → []", () => {
    project.value = makeProject([]);
    expect(eligibleMediaIds.value).toEqual([]);
  });

  it("filters hasAudio===false, includes hasAudio===undefined, excludes captioned, preserves order", () => {
    project.value = makeProject([
      makeMedia({ id: "a" }),                                            // include (no hasAudio)
      makeMedia({ id: "b", hasAudio: false }),                           // filter out
      makeMedia({ id: "c", hasAudio: true }),                            // include
      makeMedia({ id: "d", captions: [makeCaption()] }),                 // filter out
      makeMedia({ id: "e" }),                                            // include
    ]);
    expect(eligibleMediaIds.value).toEqual(["a", "c", "e"]);
  });
});

describe("allTranscribableMediaIds", () => {
  it("null project → []", () => {
    project.value = null;
    expect(allTranscribableMediaIds.value).toEqual([]);
  });

  it("empty media → []", () => {
    project.value = makeProject([]);
    expect(allTranscribableMediaIds.value).toEqual([]);
  });

  it("includes captioned, excludes hasAudio===false", () => {
    project.value = makeProject([
      makeMedia({ id: "a", captions: [makeCaption()] }),
      makeMedia({ id: "b", hasAudio: false }),
      makeMedia({ id: "c", hasAudio: true }),
    ]);
    expect(allTranscribableMediaIds.value).toEqual(["a", "c"]);
  });
});

describe("captionedMedia / captionedMediaCount", () => {
  it("null project → []", () => {
    project.value = null;
    expect(captionedMedia.value).toEqual([]);
    expect(captionedMediaCount.value).toBe(0);
  });

  it("empty media → []", () => {
    project.value = makeProject([]);
    expect(captionedMedia.value).toEqual([]);
    expect(captionedMediaCount.value).toBe(0);
  });

  it("filters to only captions.length>0", () => {
    project.value = makeProject([
      makeMedia({ id: "a", captions: [makeCaption()] }),
      makeMedia({ id: "b" }),
      makeMedia({ id: "c", captions: [makeCaption(1), makeCaption(2)] }),
    ]);
    expect(captionedMedia.value.map((m) => m.id)).toEqual(["a", "c"]);
    expect(captionedMediaCount.value).toBe(2);
  });
});

// ── runBatchGeneration no-op cases ─────────────────────────────────────────

describe("runBatchGeneration no-ops", () => {
  it("empty list: batchState stays null, no work done", async () => {
    project.value = makeProject([makeMedia()]);
    await runBatchGeneration([]);
    expect(batchState.value).toBeNull();
    expect(transcribeMediaMock).not.toHaveBeenCalled();
  });

  it("concurrent re-entry: returns early when batchState already set", async () => {
    project.value = makeProject([makeMedia()]);
    batchState.value = {
      ids: ["m1"],
      statuses: new Map([["m1", "running"]]),
      errors: new Map(),
    };
    await runBatchGeneration(["m1"]);
    expect(transcribeMediaMock).not.toHaveBeenCalled();
    // The reentry guard means we leave the externally set state alone.
    expect(batchState.value).not.toBeNull();
  });

  it("null project: returns without setting batchState", async () => {
    project.value = null;
    await runBatchGeneration(["m1"]);
    expect(batchState.value).toBeNull();
    expect(transcribeMediaMock).not.toHaveBeenCalled();
  });
});

// ── History descriptions ────────────────────────────────────────────────────

describe("history descriptions", () => {
  it("N=1 success → 'Generate captions'", async () => {
    project.value = makeProject([makeMedia({ id: "m1" })]);
    const spy = vi.spyOn(storeModule, "pushHistory");
    await runBatchGeneration(["m1"]);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][1]).toBe("Generate captions");
    spy.mockRestore();
  });

  it("N=3 full success → 'Generate captions (3 files)'", async () => {
    project.value = makeProject([
      makeMedia({ id: "a", path: "/a" }),
      makeMedia({ id: "b", path: "/b" }),
      makeMedia({ id: "c", path: "/c" }),
    ]);
    const spy = vi.spyOn(storeModule, "pushHistory");
    await runBatchGeneration(["a", "b", "c"]);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][1]).toBe("Generate captions (3 files)");
    spy.mockRestore();
  });

  it("partial (2 of 3) → 'Generate captions (2 of 3 files)'", async () => {
    project.value = makeProject([
      makeMedia({ id: "a", path: "/a" }),
      makeMedia({ id: "b", path: "/b" }),
      makeMedia({ id: "c", path: "/c" }),
    ]);
    // Second file's fileExists fails.
    fileExistsMock.mockImplementation(async (p: string) => p !== "/b");
    const spy = vi.spyOn(storeModule, "pushHistory");
    await runBatchGeneration(["a", "b", "c"]);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][1]).toBe("Generate captions (2 of 3 files)");
    spy.mockRestore();
  });
});

// ── Failure modes ───────────────────────────────────────────────────────────

describe("per-item failures", () => {
  it("file-not-found: status failed, error 'File not found'", async () => {
    project.value = makeProject([makeMedia({ id: "m1" })]);
    fileExistsMock.mockResolvedValue(false);
    await runBatchGeneration(["m1"]);
    // batchState is cleared in finally, so assert via showError + transcribe not called.
    expect(transcribeMediaMock).not.toHaveBeenCalled();
    expect(showErrorMock).toHaveBeenCalledOnce();
    expect(showErrorMock.mock.calls[0][0]).toContain("File not found");
  });

  it("hasAudio===false: 'No audio track', transcribe + fileExists never called", async () => {
    project.value = makeProject([makeMedia({ id: "m1", hasAudio: false })]);
    await runBatchGeneration(["m1"]);
    expect(transcribeMediaMock).not.toHaveBeenCalled();
    expect(fileExistsMock).not.toHaveBeenCalled();
    expect(showErrorMock).toHaveBeenCalledOnce();
    expect(showErrorMock.mock.calls[0][0]).toContain("No audio track");
  });

  it("id missing from project.media: 'Media not found in project'", async () => {
    project.value = makeProject([makeMedia({ id: "real" })]);
    await runBatchGeneration(["ghost"]);
    expect(showErrorMock).toHaveBeenCalledOnce();
    expect(showErrorMock.mock.calls[0][0]).toContain("Media not found in project");
    expect(transcribeMediaMock).not.toHaveBeenCalled();
  });
});

// ── Cancellation ────────────────────────────────────────────────────────────

describe("cancellation", () => {
  it("cancel mid-loop: remaining pending items become 'cancelled', partial pushHistory", async () => {
    project.value = makeProject([
      makeMedia({ id: "a", path: "/a" }),
      makeMedia({ id: "b", path: "/b" }),
      makeMedia({ id: "c", path: "/c" }),
    ]);
    // After the first item finishes, request cancel.
    transcribeMediaMock.mockImplementationOnce(async () => {
      batchCancelRequested.value = true;
      return defaultTranscribeResult;
    });
    const spy = vi.spyOn(storeModule, "pushHistory");
    await runBatchGeneration(["a", "b", "c"]);
    expect(transcribeMediaMock).toHaveBeenCalledTimes(1); // only first ran
    // Partial push with success=1, total=3 → "(1 of 3 files)"
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][1]).toBe("Generate captions (1 of 3 files)");
    spy.mockRestore();
    // batchState is cleared in finally; cancel signal also reset.
    expect(batchState.value).toBeNull();
    expect(batchCancelRequested.value).toBe(false);
  });
});

// ── Cleanup: try/finally ────────────────────────────────────────────────────

describe("try/finally cleanup", () => {
  it("transcribeMedia throws: per-item catch records, batch continues, no signal stuck", async () => {
    project.value = makeProject([
      makeMedia({ id: "a", path: "/a" }),
      makeMedia({ id: "b", path: "/b" }),
    ]);
    transcribeMediaMock.mockImplementationOnce(async () => {
      throw "boom";
    });
    // Second call succeeds (default mock).
    await runBatchGeneration(["a", "b"]);

    // Batch continued: second was transcribed.
    expect(transcribeMediaMock).toHaveBeenCalledTimes(2);
    // Error surfaced via showError for the failed one.
    expect(showErrorMock).toHaveBeenCalledOnce();
    expect(showErrorMock.mock.calls[0][0]).toContain("boom");
    // Signals released.
    expect(batchState.value).toBeNull();
    expect(batchProgress.value).toBeNull();
    expect(batchCancelRequested.value).toBe(false);
  });

  it("pushHistory throws: batchState/batchProgress/batchCancelRequested all clear in finally", async () => {
    project.value = makeProject([makeMedia({ id: "a", path: "/a" })]);
    const spy = vi.spyOn(storeModule, "pushHistory").mockImplementationOnce(() => {
      throw new Error("history boom");
    });
    await expect(runBatchGeneration(["a"])).rejects.toThrow("history boom");
    expect(batchState.value).toBeNull();
    expect(batchProgress.value).toBeNull();
    expect(batchCancelRequested.value).toBe(false);
    spy.mockRestore();
  });
});

// ── showError gating ────────────────────────────────────────────────────────

describe("showError gating", () => {
  it("not called on all-success", async () => {
    project.value = makeProject([makeMedia({ id: "a" })]);
    await runBatchGeneration(["a"]);
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("called when any errors, message starts with 'Failed to generate captions for'", async () => {
    project.value = makeProject([makeMedia({ id: "a", hasAudio: false })]);
    await runBatchGeneration(["a"]);
    expect(showErrorMock).toHaveBeenCalledOnce();
    expect(showErrorMock.mock.calls[0][0]).toMatch(/^Failed to generate captions for/);
  });
});

// ── Live per-file mutation ──────────────────────────────────────────────────

describe("live per-file mutation", () => {
  it("first item's captions populated and isDirty=true BEFORE second item resolves", async () => {
    project.value = makeProject([
      makeMedia({ id: "a", path: "/a" }),
      makeMedia({ id: "b", path: "/b" }),
    ]);

    // Deferred for the second call so we can inspect between iterations.
    let resolveSecond!: (v: typeof defaultTranscribeResult) => void;
    const secondPromise = new Promise<typeof defaultTranscribeResult>((res) => {
      resolveSecond = res;
    });

    let projectMidBatch: CodProject | null = null;
    let dirtyMidBatch = false;

    transcribeMediaMock.mockImplementationOnce(async () => defaultTranscribeResult);
    transcribeMediaMock.mockImplementationOnce(async () => {
      // Snapshot once the second call has begun — first item is now live-applied.
      projectMidBatch = project.value;
      dirtyMidBatch = isDirty.value;
      return secondPromise;
    });

    const runPromise = runBatchGeneration(["a", "b"]);
    // Let microtasks flush so the second transcribeMedia call begins.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // First file already has captions; isDirty is set.
    expect(projectMidBatch).not.toBeNull();
    const firstLive = projectMidBatch!.media.find((m) => m.id === "a")!;
    expect(firstLive.captions.length).toBeGreaterThan(0);
    expect(dirtyMidBatch).toBe(true);

    resolveSecond(defaultTranscribeResult);
    await runPromise;
  });
});

// ── cancelBatch ─────────────────────────────────────────────────────────────

describe("cancelBatch", () => {
  it("no-op when batchState null", () => {
    batchState.value = null;
    batchCancelRequested.value = false;
    cancelBatch();
    expect(batchCancelRequested.value).toBe(false);
  });

  it("sets batchCancelRequested when batchState set", () => {
    batchState.value = {
      ids: ["a"],
      statuses: new Map([["a", "running"]]),
      errors: new Map(),
    };
    batchCancelRequested.value = false;
    cancelBatch();
    expect(batchCancelRequested.value).toBe(true);
  });
});

// ── Language autodetect (should-have) ───────────────────────────────────────

describe("language autodetect", () => {
  it("project.language='' → applied media has detectedLanguage='en', generatedWithLanguage=undefined", async () => {
    project.value = makeProject([makeMedia({ id: "a" })], "");
    await runBatchGeneration(["a"]);
    const applied = project.value!.media.find((m) => m.id === "a")!;
    expect(applied.detectedLanguage).toBe("en");
    expect(applied.generatedWithLanguage).toBeUndefined();
  });

  it("project.language='en' → generatedWithLanguage='en', detectedLanguage=undefined", async () => {
    project.value = makeProject([makeMedia({ id: "a" })], "en");
    await runBatchGeneration(["a"]);
    const applied = project.value!.media.find((m) => m.id === "a")!;
    expect(applied.generatedWithLanguage).toBe("en");
    expect(applied.detectedLanguage).toBeUndefined();
  });
});

// ── pushHistory final-project reference equality (should-have) ─────────────

describe("pushHistory final project reference equality", () => {
  it("untouched media references stay === to pre-batch media items", async () => {
    const a = makeMedia({ id: "a", path: "/a" });
    const b = makeMedia({ id: "b", path: "/b", captions: [makeCaption()] }); // not batched
    project.value = makeProject([a, b]);

    let finalProject: CodProject | null = null;
    const spy = vi.spyOn(storeModule, "pushHistory").mockImplementation((p: CodProject) => {
      finalProject = p;
    });

    await runBatchGeneration(["a"]);

    expect(finalProject).not.toBeNull();
    const finalB = finalProject!.media.find((m) => m.id === "b");
    expect(finalB).toBe(b); // reference equality preserved
    spy.mockRestore();
  });
});
