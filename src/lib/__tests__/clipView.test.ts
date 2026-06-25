import { describe, it, expect, beforeEach } from "vitest";
import {
  loadClipViewForProject,
  getClipView,
  rememberClipView,
  copyClipViewProject,
  rememberActiveClip,
  getActiveClip,
} from "../clipView";

describe("clipView", () => {
  beforeEach(() => {
    localStorage.clear();
    loadClipViewForProject(null, new Set());
  });

  it("remembers and restores a clip's state per project", () => {
    loadClipViewForProject("/a.cod", new Set(["clip-1"]));
    rememberClipView("clip-1", { captionIndex: 4, playbackTime: 9, zoom: 3, timelineScroll: 120 });
    loadClipViewForProject(null, new Set());
    loadClipViewForProject("/a.cod", new Set(["clip-1"]));
    expect(getClipView("clip-1")).toEqual({ captionIndex: 4, playbackTime: 9, zoom: 3, timelineScroll: 120 });
  });

  it("prunes clips that no longer exist on load", () => {
    loadClipViewForProject("/a.cod", new Set(["clip-1", "clip-2"]));
    rememberClipView("clip-1", { captionIndex: 1, playbackTime: 0 });
    rememberClipView("clip-2", { captionIndex: 2, playbackTime: 0 });
    // Reopen with clip-2 removed from the project.
    loadClipViewForProject("/a.cod", new Set(["clip-1"]));
    expect(getClipView("clip-1")).toBeTruthy();
    expect(getClipView("clip-2")).toBeUndefined();
  });

  it("copyClipViewProject keeps the original and copies to the new key (Save As)", () => {
    loadClipViewForProject("/old.cod", new Set(["a", "b"]));
    rememberClipView("a", { captionIndex: 3, playbackTime: 12, zoom: 2 });
    rememberClipView("b", { captionIndex: null, playbackTime: 0 });

    copyClipViewProject("/old.cod", "/new.cod");

    // The new project has the copy …
    loadClipViewForProject("/new.cod", new Set(["a", "b"]));
    expect(getClipView("a")).toEqual({ captionIndex: 3, playbackTime: 12, zoom: 2 });

    // … and the original still has its memory (regression: a move would wipe it).
    loadClipViewForProject("/old.cod", new Set(["a", "b"]));
    expect(getClipView("a")).toEqual({ captionIndex: 3, playbackTime: 12, zoom: 2 });
  });

  it("remembers and clears the active clip per project", () => {
    loadClipViewForProject("/a.cod", new Set(["x", "y"]));
    rememberActiveClip("y");
    expect(getActiveClip("/a.cod")).toBe("y");
    rememberActiveClip(null); // deselect
    expect(getActiveClip("/a.cod")).toBeNull();
  });

  it("copyClipViewProject carries the active clip and keeps the original (Save As resume)", () => {
    loadClipViewForProject("/old.cod", new Set(["x"]));
    rememberActiveClip("x");
    copyClipViewProject("/old.cod", "/new.cod");
    expect(getActiveClip("/new.cod")).toBe("x");
    expect(getActiveClip("/old.cod")).toBe("x");
  });

  it("rejects malformed / out-of-range persisted values on load", () => {
    localStorage.setItem(
      "codfish:clipView",
      JSON.stringify({
        "/a.cod": {
          ok: { captionIndex: 2, playbackTime: 5 },
          badTime: { captionIndex: 0, playbackTime: -1 },
          badZoom: { captionIndex: 0, playbackTime: 0, zoom: 9000 },
          badCaption: { captionIndex: 1.5, playbackTime: 0 },
          badScroll: { captionIndex: 0, playbackTime: 0, timelineScroll: -5 },
        },
      }),
    );
    loadClipViewForProject("/a.cod", new Set(["ok", "badTime", "badZoom", "badCaption", "badScroll"]));
    expect(getClipView("ok")).toEqual({ captionIndex: 2, playbackTime: 5 });
    expect(getClipView("badTime")).toBeUndefined();
    expect(getClipView("badZoom")).toBeUndefined();
    expect(getClipView("badCaption")).toBeUndefined();
    expect(getClipView("badScroll")).toBeUndefined();
  });
});
