import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/preact";

// ── Module mocks (must be hoisted) ───────────────────────────────────────────

const cancelBatchMock = vi.fn();
vi.mock("../../lib/batch", () => ({
  cancelBatch: (...args: any[]) => (cancelBatchMock as any)(...args),
}));

import { BatchBlocker } from "../BatchBlocker";
import {
  batchState,
  batchProgress,
  batchCancelRequested,
  project,
  type BatchItemStatus,
  type BatchState,
} from "../../store/app";
import type { CodProject, MediaItem } from "../../types/project";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeMedia(id: string, name: string): MediaItem {
  return {
    id,
    name,
    path: `/fake/${id}.mp4`,
    fps: null,
    captions: [],
    exports: [],
  };
}

function makeProject(media: MediaItem[]): CodProject {
  return {
    version: 1,
    name: "test-project",
    transcriptionModel: "base",
    language: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    media,
  };
}

function makeBatchState(
  ids: string[],
  statusEntries: Record<string, BatchItemStatus>,
  errorEntries: Record<string, string> = {},
): BatchState {
  return {
    ids,
    statuses: new Map<string, BatchItemStatus>(
      ids.map((id) => [id, statusEntries[id] ?? "pending"]),
    ),
    errors: new Map<string, string>(Object.entries(errorEntries)),
  };
}

beforeEach(() => {
  cleanup();
  batchState.value = null;
  batchProgress.value = null;
  batchCancelRequested.value = false;
  project.value = null;
  cancelBatchMock.mockReset();
  // Stub scrollIntoView (not present on happy-dom Elements) and ensure a
  // fresh call history per test. vi.spyOn returns the same spy on repeat
  // calls, so we clear before each test.
  const spy = vi
    .spyOn(Element.prototype, "scrollIntoView")
    .mockImplementation(() => {});
  spy.mockClear();
});

describe("BatchBlocker: visibility", () => {
  it("returns null when batchState.value === null", () => {
    batchState.value = null;
    const { container } = render(<BatchBlocker />);
    expect(container.querySelector(".batch-blocker")).toBeNull();
  });
});

describe("BatchBlocker: summary + progress", () => {
  it("renders title, summary, and progress bar fill width", () => {
    project.value = makeProject([
      makeMedia("a", "A.mp4"),
      makeMedia("b", "B.mp4"),
      makeMedia("c", "C.mp4"),
      makeMedia("d", "D.mp4"),
    ]);
    batchState.value = makeBatchState(
      ["a", "b", "c", "d"],
      { a: "done", b: "done", c: "failed", d: "pending" },
    );

    const { container } = render(<BatchBlocker />);

    expect(container.querySelector(".batch-blocker-title")?.textContent)
      .toBe("Generating captions");
    expect(container.querySelector(".batch-blocker-summary")?.textContent)
      .toContain("3 of 4 complete");
    const fill = container.querySelector(".progress-bar-fill") as HTMLElement;
    expect(fill).toBeTruthy();
    expect(fill.style.width).toBe("75%");
  });
});

describe("BatchBlocker: rows", () => {
  it("renders one row per id with media name; falls back to id when not in project", () => {
    project.value = makeProject([
      makeMedia("a", "Alpha.mp4"),
      makeMedia("b", "Bravo.mp4"),
      makeMedia("c", "Charlie.mp4"),
    ]);
    batchState.value = makeBatchState(
      ["a", "b", "c", "missing"],
      { a: "done", b: "running", c: "failed", missing: "pending" },
    );

    const { container } = render(<BatchBlocker />);

    const rows = container.querySelectorAll(".batch-blocker-row");
    expect(rows.length).toBe(4);

    const nameOf = (id: string) =>
      container.querySelector(`[data-batch-id="${id}"] .batch-blocker-row-name`)
        ?.textContent;
    expect(nameOf("a")).toBe("Alpha.mp4");
    expect(nameOf("b")).toBe("Bravo.mp4");
    expect(nameOf("c")).toBe("Charlie.mp4");
    expect(nameOf("missing")).toBe("missing");
  });

  it("applies per-status class names and renders correct icon for each", () => {
    project.value = makeProject([
      makeMedia("a", "A"),
      makeMedia("b", "B"),
      makeMedia("c", "C"),
      makeMedia("d", "D"),
      makeMedia("e", "E"),
    ]);
    batchState.value = makeBatchState(
      ["a", "b", "c", "d", "e"],
      {
        a: "done",
        b: "running",
        c: "failed",
        d: "pending",
        e: "cancelled",
      },
    );

    const { container } = render(<BatchBlocker />);

    const rowOf = (id: string) =>
      container.querySelector(`[data-batch-id="${id}"]`) as HTMLElement;

    expect(rowOf("a").classList.contains("batch-blocker-row--done")).toBe(true);
    expect(rowOf("b").classList.contains("batch-blocker-row--running")).toBe(true);
    expect(rowOf("c").classList.contains("batch-blocker-row--failed")).toBe(true);
    expect(rowOf("d").classList.contains("batch-blocker-row--pending")).toBe(true);
    expect(rowOf("e").classList.contains("batch-blocker-row--cancelled")).toBe(true);

    // Running row has .batch-spin
    expect(rowOf("b").querySelector(".batch-spin")).toBeTruthy();
    // Pending + cancelled rows contain .batch-blocker-row-dot
    expect(rowOf("d").querySelector(".batch-blocker-row-dot")).toBeTruthy();
    expect(rowOf("e").querySelector(".batch-blocker-row-dot")).toBeTruthy();
  });

  it("running row has data-batch-id and renders progress.message inside it only", () => {
    project.value = makeProject([
      makeMedia("a", "A"),
      makeMedia("b", "B"),
    ]);
    batchState.value = makeBatchState(
      ["a", "b"],
      { a: "done", b: "running" },
    );
    batchProgress.value = {
      stage: "transcribing",
      percent: 50,
      message: "Loading model",
    };

    const { container } = render(<BatchBlocker />);

    const runningRow = container.querySelector(`[data-batch-id="b"]`) as HTMLElement;
    expect(runningRow).toBeTruthy();
    expect(runningRow.getAttribute("data-batch-id")).toBe("b");
    const msg = runningRow.querySelector(".batch-blocker-row-msg");
    expect(msg?.textContent).toBe("Loading model");

    // Only one msg element in the whole list (the running row's)
    const allMsgs = container.querySelectorAll(".batch-blocker-row-msg");
    expect(allMsgs.length).toBe(1);
  });

  it("failed row renders .batch-blocker-row-msg--error with the error text", () => {
    project.value = makeProject([makeMedia("a", "A"), makeMedia("b", "B")]);
    batchState.value = makeBatchState(
      ["a", "b"],
      { a: "done", b: "failed" },
      { b: "Boom: oops" },
    );

    const { container } = render(<BatchBlocker />);

    const failedRow = container.querySelector(`[data-batch-id="b"]`) as HTMLElement;
    const errMsg = failedRow.querySelector(".batch-blocker-row-msg--error");
    expect(errMsg?.textContent).toBe("Boom: oops");
  });
});

describe("BatchBlocker: cancel button", () => {
  it("is enabled and calls cancelBatch when not cancel-requested", () => {
    project.value = makeProject([makeMedia("a", "A")]);
    batchState.value = makeBatchState(["a"], { a: "running" });
    batchCancelRequested.value = false;

    const { container } = render(<BatchBlocker />);
    const btn = container.querySelector(
      ".batch-blocker-actions button",
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe("Cancel");
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);
    expect(cancelBatchMock).toHaveBeenCalledTimes(1);
  });

  it("shows 'Stopping…' and is disabled when cancel-requested; click is a no-op", () => {
    project.value = makeProject([makeMedia("a", "A")]);
    batchState.value = makeBatchState(["a"], { a: "running" });
    batchCancelRequested.value = true;

    const { container } = render(<BatchBlocker />);
    const btn = container.querySelector(
      ".batch-blocker-actions button",
    ) as HTMLButtonElement;
    expect(btn.textContent).toBe("Stopping…");
    expect(btn.disabled).toBe(true);

    fireEvent.click(btn);
    expect(cancelBatchMock).not.toHaveBeenCalled();
  });
});

describe("BatchBlocker: auto-scroll", () => {
  it("scrolls the running row into view when currentId changes", () => {
    const scrollSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});

    project.value = makeProject([
      makeMedia("a", "A"),
      makeMedia("b", "B"),
    ]);
    batchState.value = makeBatchState(["a", "b"], { a: "running", b: "pending" });

    const { rerender } = render(<BatchBlocker />);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    // Initial call was on the row for "a"
    const firstCallThis = scrollSpy.mock.instances[0] as Element;
    expect(firstCallThis.getAttribute("data-batch-id")).toBe("a");

    // Mutate batch state so "b" is now running
    batchState.value = makeBatchState(["a", "b"], { a: "done", b: "running" });
    rerender(<BatchBlocker />);

    expect(scrollSpy).toHaveBeenCalledTimes(2);
    const secondCallThis = scrollSpy.mock.instances[1] as Element;
    expect(secondCallThis.getAttribute("data-batch-id")).toBe("b");
    expect(scrollSpy.mock.calls[1][0]).toEqual({
      behavior: "smooth",
      block: "nearest",
    });
  });

  it("does not call scrollIntoView when no row is running (currentId === null)", () => {
    const scrollSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});

    project.value = makeProject([
      makeMedia("a", "A"),
      makeMedia("b", "B"),
    ]);
    batchState.value = makeBatchState(["a", "b"], { a: "done", b: "pending" });

    render(<BatchBlocker />);
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});
