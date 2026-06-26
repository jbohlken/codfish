import { describe, it, expect } from "vitest";
import { frameStep, frameMidpoint, nextBoundary } from "../playhead";

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
