import { describe, it, expect, beforeEach } from "vitest";
import {
  project,
  isDirty,
  selectedMediaId,
  selectedCaptionIndex,
  selectedMedia,
  selectedCaption,
  resetHistory,
  pushHistory,
  undo,
  redo,
  canUndo,
  canRedo,
  undoDescription,
  redoDescription,
} from "../app";
import type { CodProject } from "../../types/project";

function makeProject(name: string, captionCount = 0): CodProject {
  const captions = Array.from({ length: captionCount }, (_, i) => ({
    index: i + 1,
    start: i * 2,
    end: i * 2 + 1.5,
    lines: [`Caption ${i + 1}`],
  }));
  return {
    version: 1,
    name,
    transcriptionModel: "base",
    language: "en",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    media: [{
      id: "media-1",
      name: "test.mp4",
      path: "/test.mp4",
      fps: 30,
      captions,
      exports: [],
    }],
  };
}

describe("undo / redo", () => {
  beforeEach(() => {
    resetHistory();
    project.value = null;
    isDirty.value = false;
    selectedMediaId.value = null;
    selectedCaptionIndex.value = null;
  });

  describe("resetHistory", () => {
    it("initializes with a project", () => {
      const proj = makeProject("Test");
      resetHistory(proj);
      expect(project.value).toBeNull(); // resetHistory doesn't set project.value
      expect(canUndo.value).toBe(false);
      expect(canRedo.value).toBe(false);
    });

    it("clears history when called without args", () => {
      const proj = makeProject("Test");
      resetHistory(proj);
      pushHistory(makeProject("Edit 1"), "Edit 1");
      resetHistory();
      expect(canUndo.value).toBe(false);
      expect(canRedo.value).toBe(false);
    });
  });

  describe("pushHistory", () => {
    it("sets project and marks dirty", () => {
      const proj = makeProject("Initial");
      resetHistory(proj);
      const edited = makeProject("Edited");
      pushHistory(edited, "Rename");
      expect(project.value).toBe(edited);
      expect(isDirty.value).toBe(true);
    });

    it("enables undo after push", () => {
      resetHistory(makeProject("Initial"));
      expect(canUndo.value).toBe(false);
      pushHistory(makeProject("Edit 1"), "Edit 1");
      expect(canUndo.value).toBe(true);
    });

    it("uses default description when none provided", () => {
      resetHistory(makeProject("Initial"));
      pushHistory(makeProject("Edit 1"));
      expect(undoDescription.value).toBe("Edit");
    });

    it("truncates future history on new push", () => {
      resetHistory(makeProject("v0"));
      pushHistory(makeProject("v1"), "Edit 1");
      pushHistory(makeProject("v2"), "Edit 2");
      pushHistory(makeProject("v3"), "Edit 3");
      undo(); // at v2
      undo(); // at v1
      pushHistory(makeProject("v1b"), "Branch");
      expect(canRedo.value).toBe(false);
      expect(project.value?.name).toBe("v1b");
    });
  });

  describe("undo", () => {
    it("restores previous state", () => {
      const initial = makeProject("v0");
      resetHistory(initial);
      pushHistory(makeProject("v1"), "Edit 1");
      undo();
      expect(project.value).toBe(initial);
    });

    it("is no-op at beginning of history", () => {
      const initial = makeProject("v0");
      resetHistory(initial);
      project.value = initial;
      undo();
      expect(project.value).toBe(initial);
      expect(canUndo.value).toBe(false);
    });

    it("marks dirty on undo", () => {
      resetHistory(makeProject("v0"));
      pushHistory(makeProject("v1"), "Edit 1");
      isDirty.value = false;
      undo();
      expect(isDirty.value).toBe(true);
    });

    it("can undo multiple steps", () => {
      const v0 = makeProject("v0");
      resetHistory(v0);
      pushHistory(makeProject("v1"), "Edit 1");
      pushHistory(makeProject("v2"), "Edit 2");
      pushHistory(makeProject("v3"), "Edit 3");
      undo();
      expect(project.value?.name).toBe("v2");
      undo();
      expect(project.value?.name).toBe("v1");
      undo();
      expect(project.value?.name).toBe("v0");
      expect(canUndo.value).toBe(false);
    });
  });

  describe("redo", () => {
    it("restores next state", () => {
      resetHistory(makeProject("v0"));
      const v1 = makeProject("v1");
      pushHistory(v1, "Edit 1");
      undo();
      redo();
      expect(project.value).toBe(v1);
    });

    it("is no-op at end of history", () => {
      resetHistory(makeProject("v0"));
      pushHistory(makeProject("v1"), "Edit 1");
      redo();
      expect(project.value?.name).toBe("v1");
    });

    it("marks dirty on redo", () => {
      resetHistory(makeProject("v0"));
      pushHistory(makeProject("v1"), "Edit 1");
      undo();
      isDirty.value = false;
      redo();
      expect(isDirty.value).toBe(true);
    });

    it("can redo multiple steps", () => {
      resetHistory(makeProject("v0"));
      pushHistory(makeProject("v1"), "Edit 1");
      pushHistory(makeProject("v2"), "Edit 2");
      pushHistory(makeProject("v3"), "Edit 3");
      undo();
      undo();
      undo();
      redo();
      expect(project.value?.name).toBe("v1");
      redo();
      expect(project.value?.name).toBe("v2");
      redo();
      expect(project.value?.name).toBe("v3");
      expect(canRedo.value).toBe(false);
    });
  });

  describe("selection restoration", () => {
    it("restores selectedMediaId on undo even after switching media", () => {
      resetHistory(makeProject("v0"));
      selectedMediaId.value = "media-a";
      selectedCaptionIndex.value = 2;
      pushHistory(makeProject("v1"), "Edit on media-a");
      // User switches to a different media item without editing
      selectedMediaId.value = "media-b";
      selectedCaptionIndex.value = null;
      undo();
      expect(selectedMediaId.value).toBe("media-a");
      expect(selectedCaptionIndex.value).toBe(2);
    });

    it("restores selection on redo", () => {
      resetHistory(makeProject("v0"));
      selectedMediaId.value = "media-a";
      selectedCaptionIndex.value = 1;
      pushHistory(makeProject("v1"), "Edit"); // captures (media-a, 1)
      selectedMediaId.value = "media-a";
      selectedCaptionIndex.value = 5;
      pushHistory(makeProject("v2"), "Another edit"); // captures (media-a, 5)
      // Undo v2 → land where v2 happened so the user sees what was undone.
      undo();
      expect(selectedCaptionIndex.value).toBe(5);
      // Undo v1 → land where v1 happened.
      undo();
      expect(selectedCaptionIndex.value).toBe(1);
      // Redo v1 → land where v1 was performed.
      redo();
      expect(selectedCaptionIndex.value).toBe(1);
      // Redo v2 → land where v2 was performed.
      redo();
      expect(selectedCaptionIndex.value).toBe(5);
    });

    it("post-op selection lands on different spot than pre-op", () => {
      // Models delete: pre-op selection = deleted caption; post-op = neighbor.
      resetHistory(makeProject("v0"));
      selectedMediaId.value = "media-a";
      selectedCaptionIndex.value = 3;
      pushHistory(makeProject("v1"), "Delete caption", {
        selectedMediaId: "media-a",
        selectedCaptionIndex: 2,
      });
      // Simulate caller moving selection to neighbor after push
      selectedCaptionIndex.value = 2;
      // Undo → pre-op selection (the deleted caption)
      undo();
      expect(selectedCaptionIndex.value).toBe(3);
      // Redo → post-op selection (the neighbor)
      redo();
      expect(selectedCaptionIndex.value).toBe(2);
    });
  });

  describe("descriptions", () => {
    it("undoDescription reflects current entry", () => {
      resetHistory(makeProject("v0"));
      expect(undoDescription.value).toBeNull();
      pushHistory(makeProject("v1"), "Add caption");
      expect(undoDescription.value).toBe("Add caption");
      pushHistory(makeProject("v2"), "Split caption");
      expect(undoDescription.value).toBe("Split caption");
    });

    it("redoDescription reflects next entry", () => {
      resetHistory(makeProject("v0"));
      pushHistory(makeProject("v1"), "Add caption");
      pushHistory(makeProject("v2"), "Delete caption");
      expect(redoDescription.value).toBeNull();
      undo();
      expect(redoDescription.value).toBe("Delete caption");
      undo();
      expect(redoDescription.value).toBe("Add caption");
    });

    it("undoDescription updates after undo", () => {
      resetHistory(makeProject("v0"));
      pushHistory(makeProject("v1"), "First");
      pushHistory(makeProject("v2"), "Second");
      expect(undoDescription.value).toBe("Second");
      undo();
      expect(undoDescription.value).toBe("First");
    });
  });

  describe("canUndo / canRedo", () => {
    it("both false on empty history", () => {
      resetHistory();
      expect(canUndo.value).toBe(false);
      expect(canRedo.value).toBe(false);
    });

    it("both false at initial state with no edits", () => {
      resetHistory(makeProject("v0"));
      expect(canUndo.value).toBe(false);
      expect(canRedo.value).toBe(false);
    });

    it("canUndo true, canRedo false after push", () => {
      resetHistory(makeProject("v0"));
      pushHistory(makeProject("v1"), "Edit");
      expect(canUndo.value).toBe(true);
      expect(canRedo.value).toBe(false);
    });

    it("canRedo true after undo", () => {
      resetHistory(makeProject("v0"));
      pushHistory(makeProject("v1"), "Edit");
      undo();
      expect(canUndo.value).toBe(false);
      expect(canRedo.value).toBe(true);
    });

    it("canRedo false after push from undo state", () => {
      resetHistory(makeProject("v0"));
      pushHistory(makeProject("v1"), "Edit 1");
      pushHistory(makeProject("v2"), "Edit 2");
      undo();
      expect(canRedo.value).toBe(true);
      pushHistory(makeProject("v1b"), "Branch");
      expect(canRedo.value).toBe(false);
    });
  });
});

describe("derived signals", () => {
  beforeEach(() => {
    resetHistory();
    project.value = null;
    isDirty.value = false;
    selectedMediaId.value = null;
    selectedCaptionIndex.value = null;
  });

  describe("selectedMedia", () => {
    it("returns null when no project", () => {
      expect(selectedMedia.value).toBeNull();
    });

    it("returns null when no media selected", () => {
      project.value = makeProject("Test");
      expect(selectedMedia.value).toBeNull();
    });

    it("returns the selected media item", () => {
      project.value = makeProject("Test", 3);
      selectedMediaId.value = "media-1";
      expect(selectedMedia.value?.name).toBe("test.mp4");
    });

    it("returns null for non-existent media id", () => {
      project.value = makeProject("Test");
      selectedMediaId.value = "nonexistent";
      expect(selectedMedia.value).toBeNull();
    });
  });

  describe("selectedCaption", () => {
    it("returns null when no media selected", () => {
      project.value = makeProject("Test", 3);
      expect(selectedCaption.value).toBeNull();
    });

    it("returns null when no caption index set", () => {
      project.value = makeProject("Test", 3);
      selectedMediaId.value = "media-1";
      expect(selectedCaption.value).toBeNull();
    });

    it("returns the selected caption", () => {
      project.value = makeProject("Test", 3);
      selectedMediaId.value = "media-1";
      selectedCaptionIndex.value = 1;
      expect(selectedCaption.value?.lines).toEqual(["Caption 1"]);
    });

    it("returns null for out-of-bounds index", () => {
      project.value = makeProject("Test", 3);
      selectedMediaId.value = "media-1";
      selectedCaptionIndex.value = 99;
      expect(selectedCaption.value).toBeNull();
    });
  });
});
