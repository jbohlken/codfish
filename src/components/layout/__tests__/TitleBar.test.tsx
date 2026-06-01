import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/preact";

// ── Module mocks (must be hoisted) ───────────────────────────────────────────

const generateSelectedMediaMock = vi.fn();
const generateMissingMediaMock = vi.fn();
const regenerateAllMediaMock = vi.fn();
const exportSelectedMediaMock = vi.fn();
const exportAllMediaMock = vi.fn();

vi.mock("../../../lib/actions", () => ({
  generateSelectedMedia: (...a: any[]) => generateSelectedMediaMock(...a),
  generateMissingMedia: (...a: any[]) => generateMissingMediaMock(...a),
  regenerateAllMedia: (...a: any[]) => regenerateAllMediaMock(...a),
  exportSelectedMedia: (...a: any[]) => exportSelectedMediaMock(...a),
  exportAllMedia: (...a: any[]) => exportAllMediaMock(...a),
}));

vi.mock("../../../lib/export", () => ({
  listFormats: vi.fn(async () => []),
}));

vi.mock("../../../lib/transcription", () => ({
  listModels: vi.fn(async () => []),
}));

vi.mock("../../ProfileManager", () => ({
  openProfileManager: vi.fn(),
}));

vi.mock("../../FormatManager", () => ({
  openFormatManager: vi.fn(),
}));

vi.mock("../../UpdateNotice", () => ({
  hasUpdate: () => false,
  toggleUpdatePopover: vi.fn(),
  UpdatePopover: () => null,
}));

import { TitleBar } from "../TitleBar";
import {
  project,
  isDirty,
  profiles,
  selectedProfile,
  selectedMediaId,
  selectedExportFormat,
  exportFormats,
} from "../../../store/app";
import type { CodProject, MediaItem, CaptionBlock } from "../../../types/project";
import type { CaptionProfile } from "../../../types/profile";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeProfile(): CaptionProfile {
  return {
    id: "codfish",
    name: "Codfish",
    description: "Default",
    builtIn: true,
    timing: {
      minDuration: { value: 1, strict: false, unit: "s" },
      maxDuration: { value: 7, strict: false, unit: "s" },
      maxCps: { value: 17, strict: false },
      extendToFill: false,
      extendToFillMax: 2,
      gapCloseThreshold: 0.2,
      minGapEnabled: false,
      minGapSeconds: { value: 0.08, strict: false, unit: "s" },
      defaultFps: 30,
    },
    formatting: {
      maxCharsPerLine: { value: 42, strict: false },
      maxLines: { value: 2, strict: false },
    },
    merge: {
      enabled: true,
      phraseBreakGap: 0.6,
      minSegmentWords: 3,
      mergeGapThreshold: 0.4,
    },
  };
}

function makeCaption(index: number): CaptionBlock {
  return {
    index,
    start: index,
    end: index + 1,
    lines: ["hi"],
  };
}

function makeMedia(
  id: string,
  opts: { hasAudio?: boolean; captions?: CaptionBlock[] } = {},
): MediaItem {
  return {
    id,
    name: `${id}.mp4`,
    path: `/tmp/${id}.mp4`,
    fps: 30,
    hasAudio: opts.hasAudio ?? true,
    captions: opts.captions ?? [],
    exports: [],
  };
}

function makeProject(media: MediaItem[] = []): CodProject {
  return {
    version: 1,
    name: "test",
    transcriptionModel: "base",
    language: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    media,
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  cleanup();
  project.value = null;
  isDirty.value = false;
  selectedMediaId.value = null;
  selectedProfile.value = "Codfish";
  selectedExportFormat.value = "SRT";
  exportFormats.value = [];
  profiles.value = [makeProfile()];
  generateSelectedMediaMock.mockClear();
  generateMissingMediaMock.mockClear();
  regenerateAllMediaMock.mockClear();
  exportSelectedMediaMock.mockClear();
  exportAllMediaMock.mockClear();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Find an action menu button by its label (Generate or Export). */
function findActionButton(label: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button.titlebar-select-btn--action")) as HTMLButtonElement[];
  const match = buttons.find((b) => b.textContent?.includes(label));
  if (!match) throw new Error(`No action button with label "${label}"`);
  return match;
}

/** Get the menu option whose .titlebar-select-option-name starts with `name`. */
function findOption(name: string): HTMLButtonElement {
  const options = Array.from(
    document.querySelectorAll("button.titlebar-select-option"),
  ) as HTMLButtonElement[];
  const match = options.find((o) => {
    const nameEl = o.querySelector(".titlebar-select-option-name");
    return nameEl?.textContent === name;
  });
  if (!match) throw new Error(`No menu option named "${name}"`);
  return match;
}

function getMeta(option: HTMLButtonElement): string | null {
  return option.querySelector(".titlebar-select-option-meta")?.textContent ?? null;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TitleBar — no project", () => {
  it("renders 'Codfish' but omits right-side controls when project is null", () => {
    project.value = null;
    render(<TitleBar />);
    expect(screen.getByText("Codfish")).toBeTruthy();
    // No SelectButtons or ActionMenuButtons should be in the DOM.
    expect(document.querySelector(".titlebar-select-btn")).toBeNull();
    expect(document.querySelector(".titlebar-select-btn--action")).toBeNull();
  });
});

describe("TitleBar — Generate menu / current file", () => {
  it("no media selected → 'Generate current file' disabled with 'Select a media item first'", () => {
    project.value = makeProject([makeMedia("a")]);
    selectedMediaId.value = null;
    render(<TitleBar />);
    fireEvent.click(findActionButton("Generate"));
    const opt = findOption("Generate current file");
    expect(opt.disabled).toBe(true);
    expect(opt.getAttribute("data-tooltip")).toBe("Select a media item first");
  });

  it("selected media without audio → disabled with 'Selected file has no audio track'", () => {
    const m = makeMedia("a", { hasAudio: false });
    project.value = makeProject([m]);
    selectedMediaId.value = "a";
    render(<TitleBar />);
    fireEvent.click(findActionButton("Generate"));
    const opt = findOption("Generate current file");
    expect(opt.disabled).toBe(true);
    expect(opt.getAttribute("data-tooltip")).toBe("Selected file has no audio track");
  });

  it("selected media with audio, no captions → enabled; label 'Generate current file'", () => {
    const m = makeMedia("a", { hasAudio: true, captions: [] });
    project.value = makeProject([m]);
    selectedMediaId.value = "a";
    render(<TitleBar />);
    fireEvent.click(findActionButton("Generate"));
    const opt = findOption("Generate current file");
    expect(opt.disabled).toBe(false);
  });

  it("selected media with captions → enabled; label 'Regenerate current file'", () => {
    const m = makeMedia("a", { hasAudio: true, captions: [makeCaption(0)] });
    project.value = makeProject([m]);
    selectedMediaId.value = "a";
    render(<TitleBar />);
    fireEvent.click(findActionButton("Generate"));
    const opt = findOption("Regenerate current file");
    expect(opt.disabled).toBe(false);
  });
});

describe("TitleBar — Generate menu / Generate missing", () => {
  it("missingCount === 0 → disabled with 'All files already have captions'; meta '(0)'", () => {
    const m = makeMedia("a", { hasAudio: true, captions: [makeCaption(0)] });
    project.value = makeProject([m]);
    render(<TitleBar />);
    fireEvent.click(findActionButton("Generate"));
    const opt = findOption("Generate missing");
    expect(opt.disabled).toBe(true);
    expect(opt.getAttribute("data-tooltip")).toBe("All files already have captions");
    expect(getMeta(opt)).toBe("(0)");
  });

  it("missingCount > 0 → enabled with meta '(N)'", () => {
    project.value = makeProject([
      makeMedia("a"),
      makeMedia("b"),
      makeMedia("c", { captions: [makeCaption(0)] }),
    ]);
    render(<TitleBar />);
    fireEvent.click(findActionButton("Generate"));
    const opt = findOption("Generate missing");
    expect(opt.disabled).toBe(false);
    expect(getMeta(opt)).toBe("(2)");
  });
});

describe("TitleBar — Generate menu / Regenerate everything", () => {
  it("captionedCount === 0 → disabled, danger class, tooltip 'Nothing generated yet'", () => {
    project.value = makeProject([makeMedia("a")]);
    render(<TitleBar />);
    fireEvent.click(findActionButton("Generate"));
    const opt = findOption("Regenerate everything");
    expect(opt.disabled).toBe(true);
    expect(opt.getAttribute("data-tooltip")).toBe("Nothing generated yet");
    expect(opt.className).toContain("titlebar-select-option--danger");
  });

  it("transcribableCount === 0 → disabled with tooltip 'No transcribable media'", () => {
    // Need a media that already has captions (so captionedCount > 0) but no audio
    // (so transcribableCount === 0). hasAudio:false excludes from
    // allTranscribableMediaIds, but captions still count for captionedMedia.
    const m = makeMedia("a", { hasAudio: false, captions: [makeCaption(0)] });
    project.value = makeProject([m]);
    render(<TitleBar />);
    fireEvent.click(findActionButton("Generate"));
    const opt = findOption("Regenerate everything");
    expect(opt.disabled).toBe(true);
    expect(opt.getAttribute("data-tooltip")).toBe("No transcribable media");
  });

  it("mixed enabled state → enabled with danger class; meta == transcribableCount", () => {
    project.value = makeProject([
      makeMedia("a", { hasAudio: true, captions: [makeCaption(0)] }),
      makeMedia("b", { hasAudio: true }),
    ]);
    render(<TitleBar />);
    fireEvent.click(findActionButton("Generate"));
    const opt = findOption("Regenerate everything");
    expect(opt.disabled).toBe(false);
    expect(opt.className).toContain("titlebar-select-option--danger");
    expect(getMeta(opt)).toBe("(2)");
  });
});

describe("TitleBar — Export menu / Export current file", () => {
  it("no selection → disabled with 'Select a media item first'", () => {
    project.value = makeProject([makeMedia("a")]);
    selectedMediaId.value = null;
    render(<TitleBar />);
    fireEvent.click(findActionButton("Export"));
    const opt = findOption("Export current file");
    expect(opt.disabled).toBe(true);
    expect(opt.getAttribute("data-tooltip")).toBe("Select a media item first");
  });

  it("selected without captions → disabled with 'Selected file has no captions'", () => {
    project.value = makeProject([makeMedia("a")]);
    selectedMediaId.value = "a";
    render(<TitleBar />);
    fireEvent.click(findActionButton("Export"));
    const opt = findOption("Export current file");
    expect(opt.disabled).toBe(true);
    expect(opt.getAttribute("data-tooltip")).toBe("Selected file has no captions");
  });

  it("selected with captions → enabled", () => {
    project.value = makeProject([
      makeMedia("a", { captions: [makeCaption(0)] }),
    ]);
    selectedMediaId.value = "a";
    render(<TitleBar />);
    fireEvent.click(findActionButton("Export"));
    const opt = findOption("Export current file");
    expect(opt.disabled).toBe(false);
  });
});

describe("TitleBar — Export menu / Export all", () => {
  it("captionedCount === 0 → disabled with 'No captioned media to export'; meta '(0)'", () => {
    project.value = makeProject([makeMedia("a"), makeMedia("b")]);
    render(<TitleBar />);
    fireEvent.click(findActionButton("Export"));
    const opt = findOption("Export all");
    expect(opt.disabled).toBe(true);
    expect(opt.getAttribute("data-tooltip")).toBe("No captioned media to export");
    expect(getMeta(opt)).toBe("(0)");
  });

  it("captionedCount > 0 → enabled with correct meta", () => {
    project.value = makeProject([
      makeMedia("a", { captions: [makeCaption(0)] }),
      makeMedia("b", { captions: [makeCaption(0)] }),
      makeMedia("c"),
    ]);
    render(<TitleBar />);
    fireEvent.click(findActionButton("Export"));
    const opt = findOption("Export all");
    expect(opt.disabled).toBe(false);
    expect(getMeta(opt)).toBe("(2)");
  });
});

describe("TitleBar — reactivity", () => {
  it("computed signals subscribe: updating project.value updates 'Export all' meta on reopen", () => {
    project.value = makeProject([makeMedia("a")]);
    render(<TitleBar />);

    fireEvent.click(findActionButton("Export"));
    let opt = findOption("Export all");
    expect(getMeta(opt)).toBe("(0)");

    // Close the menu, mutate project.value, reopen, and assert.
    fireEvent.click(findActionButton("Export"));
    project.value = makeProject([
      makeMedia("a", { captions: [makeCaption(0)] }),
    ]);
    fireEvent.click(findActionButton("Export"));
    opt = findOption("Export all");
    expect(getMeta(opt)).toBe("(1)");
  });
});

describe("TitleBar — click handlers", () => {
  it("clicking enabled 'Generate current file' calls generateSelectedMedia once", () => {
    project.value = makeProject([
      makeMedia("a", { hasAudio: true }),
    ]);
    selectedMediaId.value = "a";
    render(<TitleBar />);
    fireEvent.click(findActionButton("Generate"));
    fireEvent.click(findOption("Generate current file"));
    expect(generateSelectedMediaMock).toHaveBeenCalledTimes(1);
  });

  it("clicking enabled 'Generate missing' calls generateMissingMedia once", () => {
    project.value = makeProject([makeMedia("a"), makeMedia("b")]);
    render(<TitleBar />);
    fireEvent.click(findActionButton("Generate"));
    fireEvent.click(findOption("Generate missing"));
    expect(generateMissingMediaMock).toHaveBeenCalledTimes(1);
  });

  it("clicking enabled 'Regenerate everything' calls regenerateAllMedia once", () => {
    project.value = makeProject([
      makeMedia("a", { hasAudio: true, captions: [makeCaption(0)] }),
    ]);
    render(<TitleBar />);
    fireEvent.click(findActionButton("Generate"));
    fireEvent.click(findOption("Regenerate everything"));
    expect(regenerateAllMediaMock).toHaveBeenCalledTimes(1);
  });

  it("clicking enabled 'Export current file' calls exportSelectedMedia once", () => {
    project.value = makeProject([
      makeMedia("a", { captions: [makeCaption(0)] }),
    ]);
    selectedMediaId.value = "a";
    render(<TitleBar />);
    fireEvent.click(findActionButton("Export"));
    fireEvent.click(findOption("Export current file"));
    expect(exportSelectedMediaMock).toHaveBeenCalledTimes(1);
  });

  it("clicking enabled 'Export all' calls exportAllMedia once", () => {
    project.value = makeProject([
      makeMedia("a", { captions: [makeCaption(0)] }),
    ]);
    render(<TitleBar />);
    fireEvent.click(findActionButton("Export"));
    fireEvent.click(findOption("Export all"));
    expect(exportAllMediaMock).toHaveBeenCalledTimes(1);
  });
});
