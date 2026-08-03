import { describe, it, expect, beforeEach } from "vitest";
import { volume, muted, effectiveVolume, setVolume, toggleMuted } from "../app";

beforeEach(() => {
  volume.value = 1;
  muted.value = false;
});

describe("volume state (shared by both players)", () => {
  it("applies a quadratic taper", () => {
    setVolume(0.5);
    expect(effectiveVolume.value).toBeCloseTo(0.25);
    setVolume(1);
    expect(effectiveVolume.value).toBe(1);
    setVolume(0);
    expect(effectiveVolume.value).toBe(0);
  });

  it("mute hard-zeroes without losing the slider position", () => {
    setVolume(0.8);
    toggleMuted();
    expect(effectiveVolume.value).toBe(0);
    expect(volume.value).toBeCloseTo(0.8);
    toggleMuted();
    expect(effectiveVolume.value).toBeCloseTo(0.64);
  });

  it("clamps out-of-range values", () => {
    setVolume(1.7);
    expect(volume.value).toBe(1);
    setVolume(-0.3);
    expect(volume.value).toBe(0);
  });

  it("dragging the slider to a nonzero level unmutes; dragging to zero does not", () => {
    toggleMuted();
    setVolume(0.3);
    expect(muted.value).toBe(false);
    expect(effectiveVolume.value).toBeCloseTo(0.09);

    toggleMuted();
    setVolume(0);
    expect(muted.value).toBe(true);
    expect(effectiveVolume.value).toBe(0);
  });
});
