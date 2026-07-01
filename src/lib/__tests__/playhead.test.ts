import { describe, it, expect } from "vitest";
import { frameStep, frameMidpoint, nextBoundary, clampStart, clampEnd, snapToMediaFrame, computeTrim, computeRoll, computeAddCaption } from "../playhead";

const FPS = 30;

describe("frameStep", () => {
  it("on a frame: advances exactly one in each direction", () => {
    expect(frameStep(5 / FPS, FPS, 1)).toBeCloseTo(6 / FPS, 9);
    expect(frameStep(5 / FPS, FPS, -1)).toBeCloseTo(4 / FPS, 9);
  });

  it("between frames: snaps to the boundary in the press direction, not the nearest frame", () => {
    // Playhead in the FAR half between frames 1 and 2 (closer to 2). Right must
    // still land on 2 — the regression: "round to nearest, then +1" jumps to 3.
    expect(frameStep(1.7 / FPS, FPS, 1)).toBeCloseTo(2 / FPS, 9);
    // Near half (closer to 1): Right also lands on 2.
    expect(frameStep(1.3 / FPS, FPS, 1)).toBeCloseTo(2 / FPS, 9);
    // Left from anywhere between 1 and 2 lands on 1.
    expect(frameStep(1.7 / FPS, FPS, -1)).toBeCloseTo(1 / FPS, 9);
    expect(frameStep(1.3 / FPS, FPS, -1)).toBeCloseTo(1 / FPS, 9);
  });

  it("frame 0 (caller clamps the negative result to the clip start)", () => {
    expect(frameStep(0, FPS, 1)).toBeCloseTo(1 / FPS, 9);
    expect(frameStep(0, FPS, -1)).toBeCloseTo(-1 / FPS, 9);
  });
});

describe("frameMidpoint", () => {
  it("targets the middle of the frame containing the time", () => {
    expect(frameMidpoint(5 / FPS, FPS)).toBeCloseTo(5.5 / FPS, 9);   // on a boundary → mid of frame 5
    expect(frameMidpoint(5.2 / FPS, FPS)).toBeCloseTo(5.5 / FPS, 9); // within frame 5
    expect(frameMidpoint(5.9 / FPS, FPS)).toBeCloseTo(5.5 / FPS, 9); // still frame 5
  });
});

describe("nextBoundary", () => {
  const bounds = [0, 1, 2.5, 4];

  it("forward: first boundary after the time", () => {
    expect(nextBoundary(0.5, bounds, 1)).toBe(1);
    expect(nextBoundary(1.5, bounds, 1)).toBe(2.5);
  });

  it("backward: last boundary before the time", () => {
    expect(nextBoundary(1.5, bounds, -1)).toBe(1);
    expect(nextBoundary(0.5, bounds, -1)).toBe(0);
  });

  it("skips a boundary the playhead is sitting on (so repeated presses advance)", () => {
    expect(nextBoundary(1, bounds, 1)).toBe(2.5);
    expect(nextBoundary(2.5, bounds, -1)).toBe(1);
  });

  it("undefined past the ends", () => {
    expect(nextBoundary(4, bounds, 1)).toBeUndefined();
    expect(nextBoundary(0, bounds, -1)).toBeUndefined();
  });

  it("sorts unsorted input", () => {
    expect(nextBoundary(1.5, [4, 0, 2.5, 1], 1)).toBe(2.5);
  });
});

describe("clampStart", () => {
  it("passes a value already inside the valid range", () => {
    expect(clampStart(2, 1, 5, 0.1)).toBe(2);
  });
  it("clamps to the previous caption's end (no overlap)", () => {
    expect(clampStart(0.5, 1, 5, 0.1)).toBe(1);
  });
  it("clamps to own end minus the minimum duration (no invert/collapse)", () => {
    expect(clampStart(4.99, 1, 5, 0.1)).toBeCloseTo(4.9, 9);
  });
  it("floors at 0 when there is no previous caption", () => {
    expect(clampStart(-1, null, 5, 0.1)).toBe(0);
    expect(clampStart(0.5, null, 5, 0.1)).toBe(0.5);
  });
});

describe("clampEnd", () => {
  it("passes a value already inside the valid range", () => {
    expect(clampEnd(3, 1, 5, 10, 0.1)).toBe(3);
  });
  it("clamps to the next caption's start (no overlap)", () => {
    expect(clampEnd(5.5, 1, 5, 10, 0.1)).toBe(5);
  });
  it("clamps to own start plus the minimum duration (no invert/collapse)", () => {
    expect(clampEnd(1.01, 1, 5, 10, 0.1)).toBeCloseTo(1.1, 9);
  });
  it("caps at the clip duration when there is no next caption", () => {
    expect(clampEnd(99, 1, null, 10, 0.1)).toBe(10);
  });
});

describe("snapToMediaFrame", () => {
  it("rounds to the nearest frame away from the tail", () => {
    expect(snapToMediaFrame(2.01, 25, 10)).toBeCloseTo(2.0, 9);
  });
  it("behaves exactly like snapToFrame on a frame-perfect duration", () => {
    expect(snapToMediaFrame(9.99, 25, 10)).toBeCloseTo(10.0, 9);
    expect(snapToMediaFrame(9.97, 25, 10)).toBeCloseTo(9.96, 9);
  });
  it("keeps a frame-aligned media end reachable", () => {
    expect(snapToMediaFrame(10.04, 25, 10.04)).toBeCloseTo(10.04, 9);
  });
  // Partial tail cell: 10.03s @ 25fps — last whole frame at 10.00, media end 10.03.
  // The cell's real boundaries are 10.00 and 10.03; the flip point is the VISIBLE
  // midpoint (10.015), not the phantom frame's midpoint (10.02).
  it("first half of the partial tail cell rounds back to the last whole frame", () => {
    expect(snapToMediaFrame(10.01, 25, 10.03)).toBeCloseTo(10.0, 9);
  });
  it("second half of the partial tail cell rounds to the media end", () => {
    expect(snapToMediaFrame(10.02, 25, 10.03)).toBeCloseTo(10.03, 9);
  });
  it("flips at the cell's visible midpoint, not the phantom frame midpoint", () => {
    // 10.016 is past the visible midpoint (10.015) but before the phantom frame
    // midpoint (10.02) — plain snapToFrame would round it back to 10.0.
    expect(snapToMediaFrame(10.016, 25, 10.03)).toBeCloseTo(10.03, 9);
  });
  it("never lands past the media end", () => {
    expect(snapToMediaFrame(10.03, 25, 10.03)).toBeCloseTo(10.03, 9);
  });
});

describe("computeTrim", () => {
  // Captions 1 & 2 share a boundary at 3.0s; a gap precedes caption 3.
  const caps = [
    { index: 1, start: 1, end: 3 },
    { index: 2, start: 3, end: 5 },
    { index: 3, start: 6, end: 8 },
  ];
  const FPS = 30, DUR = 10;

  it("trims the in point to the playhead", () => {
    expect(computeTrim(caps, 2, "in", 4, FPS, DUR)).toEqual({ start: 4, end: 5 });
  });
  it("trims the out point to the playhead", () => {
    expect(computeTrim(caps, 1, "out", 2, FPS, DUR)).toEqual({ start: 1, end: 2 });
  });
  it("clamps the in point to the previous caption's end → no-op at a shared boundary", () => {
    expect(computeTrim(caps, 2, "in", 2, FPS, DUR)).toBeNull();
  });
  it("clamps the out point to the next caption's start → no-op at a shared boundary", () => {
    expect(computeTrim(caps, 1, "out", 4, FPS, DUR)).toBeNull();
  });
  it("first caption's in can reach the clip start (no previous caption)", () => {
    expect(computeTrim(caps, 1, "in", 0.5, FPS, DUR)).toEqual({ start: 0.5, end: 3 });
  });
  it("last caption's out can reach the clip duration (no next caption)", () => {
    expect(computeTrim(caps, 3, "out", 9, FPS, DUR)).toEqual({ start: 6, end: 9 });
  });
  it("last caption's out pins to the media end when media ends mid-frame", () => {
    // Audio ending at 10.03s @ 25fps: the snap would round to 10.04 (past the end);
    // the end pins to 10.03 itself — never past, but the whole tail stays reachable.
    const audioCaps = [{ index: 1, start: 9, end: 9.5 }];
    expect(computeTrim(audioCaps, 1, "out", 10.5, 25, 10.03)?.end).toBeCloseTo(10.03, 9);
  });
  it("returns null when the caption isn't found", () => {
    expect(computeTrim(caps, 99, "in", 4, FPS, DUR)).toBeNull();
  });
});

describe("computeRoll", () => {
  // Captions 1 & 2 share a cut at 3.0s; a gap precedes caption 3.
  const caps = [
    { index: 1, start: 1, end: 3 },
    { index: 2, start: 3, end: 5 },
    { index: 3, start: 6, end: 8 },
  ];

  it("rolls the shared cut on the selected caption's in side (both edges move)", () => {
    expect(computeRoll(caps, 2, "in", 3.5, FPS)).toEqual({
      left: { index: 1, start: 1, end: 3.5 },
      right: { index: 2, start: 3.5, end: 5 },
    });
  });
  it("rolls the same cut from the neighbour's out side", () => {
    expect(computeRoll(caps, 1, "out", 3.5, FPS)).toEqual({
      left: { index: 1, start: 1, end: 3.5 },
      right: { index: 2, start: 3.5, end: 5 },
    });
  });
  it("clamps the cut so neither caption drops below a frame", () => {
    const r = computeRoll(caps, 2, "in", 0, FPS); // dragged far past the left
    expect(r?.left.end).toBeCloseTo(1 + 1 / FPS, 9);
    expect(r?.right.start).toBeCloseTo(1 + 1 / FPS, 9);
  });
  it("is a no-op when the cut wouldn't move", () => {
    expect(computeRoll(caps, 2, "in", 3, FPS)).toBeNull();
  });
  it("returns null with no neighbour on that side (first caption's in)", () => {
    expect(computeRoll(caps, 1, "in", 2, FPS)).toBeNull();
  });
  it("returns null with no neighbour on that side (last caption's out)", () => {
    expect(computeRoll(caps, 3, "out", 7, FPS)).toBeNull();
  });
  it("returns null when the boundary isn't shared (a gap, not a cut)", () => {
    expect(computeRoll(caps, 2, "out", 5.5, FPS)).toBeNull();
  });
});

describe("computeAddCaption", () => {
  it("adds a 2s caption at the playhead on an empty timeline", () => {
    expect(computeAddCaption([], 1, 25, 100)).toEqual({ start: 1, end: 3, insertPos: 0 });
  });
  it("returns null when the playhead is inside an existing caption", () => {
    expect(computeAddCaption([{ start: 0, end: 5 }], 2, 25, 100)).toBeNull();
  });
  it("caps the end at the next caption's start and inserts before it", () => {
    const caps = [{ start: 1, end: 2 }, { start: 4, end: 6 }];
    expect(computeAddCaption(caps, 3, 25, 100)).toEqual({ start: 3, end: 4, insertPos: 1 });
  });
  it("returns null at the media end (start rounds past the pinned cap)", () => {
    // Playhead parked at the very end of a 10.03s file @ 25fps: the start snaps to
    // 10.04, past the end cap of 10.03 — nothing left to caption.
    expect(computeAddCaption([], 10.03, 25, 10.03)).toBeNull();
  });
  it("pins the tail end to the media end when media ends mid-frame", () => {
    // playhead at 9s on a 10.03s file → end pinned at 10.03, not rounded to 10.04.
    expect(computeAddCaption([], 9, 25, 10.03)).toEqual({ start: 9, end: 10.03, insertPos: 0 });
  });
  it("allows a caption on the last frame when the duration is reported a hair short", () => {
    // Production case: 30fps media reported as 81.933s — frame 2457 starts at 81.9
    // and the true frame end (2458/30 = 81.9333…) is 0.3ms past the reported
    // duration. Adding on frame 2457 must work, ending at the media end.
    const r = computeAddCaption([], 81.9, 30, 81.933);
    expect(r?.start).toBeCloseTo(81.9, 9);
    expect(r?.end).toBeCloseTo(81.933, 9);
  });
  it("first half of the tail cell → add enabled (start rounds back)", () => {
    // Same file, playhead at 81.91 — before the cell's visible midpoint (81.9165).
    const r = computeAddCaption([], 81.91, 30, 81.933);
    expect(r?.start).toBeCloseTo(81.9, 9);
    expect(r?.end).toBeCloseTo(81.933, 9);
  });
  it("second half of the tail cell → add disabled (start rounds to the end)", () => {
    // Playhead at 81.92 — past the visible midpoint → effectively at the end.
    expect(computeAddCaption([], 81.92, 30, 81.933)).toBeNull();
  });
});
