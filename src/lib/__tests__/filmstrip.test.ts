import { describe, it, expect } from "vitest";
import { slotWidthPx, visibleSlotRange, slotCenterTime, thumbKey, keyTime, clampKeyFps } from "../filmstrip";

describe("slotWidthPx", () => {
  it("derives width from row height and aspect", () => {
    expect(slotWidthPx(44, 16 / 9)).toBe(78);
    expect(slotWidthPx(44, 1)).toBe(44);
  });
  it("floors degenerate aspects at 24px and defaults bad input to 16:9", () => {
    expect(slotWidthPx(44, 0.1)).toBe(24);
    expect(slotWidthPx(44, 0)).toBe(78);
    expect(slotWidthPx(44, NaN)).toBe(78);
  });
});

describe("visibleSlotRange", () => {
  it("covers exactly the slots intersecting the viewport", () => {
    // 1000px content, 100px slots, viewport [250, 450): slots 2..4.
    expect(visibleSlotRange(250, 200, 1000, 100)).toEqual({ first: 2, last: 4 });
  });
  it("clamps to content bounds", () => {
    expect(visibleSlotRange(0, 200, 1000, 100)).toEqual({ first: 0, last: 1 });
    expect(visibleSlotRange(950, 500, 1000, 100)).toEqual({ first: 9, last: 9 });
  });
  it("never inverts on a degenerate viewport", () => {
    const r = visibleSlotRange(999, 1, 1000, 100);
    expect(r.last).toBeGreaterThanOrEqual(r.first);
  });
});

describe("slotCenterTime / thumbKey / keyTime", () => {
  it("maps a slot's center pixel to media time", () => {
    // 1000px = 10s → slot 2 of 100px centers at 250px = 2.5s.
    expect(slotCenterTime(2, 100, 1000, 10)).toBeCloseTo(2.5);
  });
  it("clamps the last slot's center inside the media", () => {
    expect(slotCenterTime(9, 100, 1000, 10)).toBeLessThan(10);
  });

  it("keys are zoom-independent (same frame → same key, either zoom)", () => {
    const keyFps = 30;
    // The same 2.5s region seen at two zooms: centers differ by < 1/30s.
    const zoomedOut = slotCenterTime(2, 100, 1000, 10);   // 2.5
    const zoomedIn = slotCenterTime(24, 100, 10000, 10);  // 2.45
    expect(thumbKey(zoomedOut, keyFps)).toBe(75);
    expect(thumbKey(zoomedIn, keyFps)).toBe(Math.round(2.45 * 30));
    // And an identical time always keys identically.
    expect(thumbKey(2.5, keyFps)).toBe(thumbKey(2.5, keyFps));
  });

  it("keyTime inverts thumbKey and stays inside the media", () => {
    expect(keyTime(75, 30, 10)).toBeCloseTo(2.5);
    expect(keyTime(0, 30, 10)).toBe(0);
    expect(keyTime(30_000, 30, 10)).toBeLessThan(10);
  });
});

describe("clampKeyFps", () => {
  it("caps at 30 (one thumb per frame max, 30/s ceiling)", () => {
    expect(clampKeyFps(60)).toBe(30);
    expect(clampKeyFps(23.976)).toBe(23.976);
  });
  it("floors at 1 and defaults null/garbage to 30", () => {
    expect(clampKeyFps(0.25)).toBe(1);
    expect(clampKeyFps(null)).toBe(30);
    expect(clampKeyFps(NaN)).toBe(30);
  });
});
