import { describe, it, expect, vi } from "vitest";
import { loadPeaks, type PeaksPipelineDeps } from "../peaksPipeline";
import type { GeneratedPeaks } from "../peaksMediabunny";

const PATH = "C:\\media\\clip.mp4";
const MTIME = 1234;

const mb = (over: Partial<GeneratedPeaks> = {}): GeneratedPeaks => ({
  peaks: new Float32Array([0.1, 0.5]),
  duration: 5,
  binsPerSec: 2000,
  ...over,
});

/** All-happy fakes; override per test. */
function makeDeps(over: Partial<PeaksPipelineDeps> = {}): PeaksPipelineDeps {
  return {
    getMtime: vi.fn(async () => MTIME),
    getCached: vi.fn(async () => null),
    cache: vi.fn(),
    generateInProcess: vi.fn(async () => mb()),
    generateSidecar: vi.fn(async () => ({ peaks: [0.2, 0.4], duration: 6 })),
    waitForElementDuration: vi.fn(async () => 100),
    log: vi.fn(),
    ...over,
  };
}

const never = () => false;

describe("loadPeaks branching", () => {
  it("cache hit: returns cached peaks, calls no generator", async () => {
    const entry = { peaks: new Float32Array([0.9]), duration: 4 };
    const deps = makeDeps({ getCached: vi.fn(async () => entry) });

    const r = await loadPeaks(PATH, never, deps);

    expect(r).toEqual({ peaks: entry.peaks, duration: 4, source: "cache" });
    expect(deps.getCached).toHaveBeenCalledWith(PATH, MTIME);
    expect(deps.generateInProcess).not.toHaveBeenCalled();
    expect(deps.generateSidecar).not.toHaveBeenCalled();
    expect(deps.cache).not.toHaveBeenCalled();
  });

  it("cache miss → mediabunny: caches with its binsPerSec, skips the sidecar", async () => {
    const deps = makeDeps();

    const r = await loadPeaks(PATH, never, deps);

    expect(r?.source).toBe("mediabunny");
    expect(r?.duration).toBe(5);
    expect(deps.cache).toHaveBeenCalledWith(PATH, MTIME, expect.any(Float32Array), 5, 2000);
    expect(deps.generateSidecar).not.toHaveBeenCalled();
    expect(deps.waitForElementDuration).not.toHaveBeenCalled();
  });

  it("mediabunny declines → sidecar: density from the element clock", async () => {
    const deps = makeDeps({
      generateInProcess: vi.fn(async () => null),
      waitForElementDuration: vi.fn(async () => 100), // 300k/100 = 3000 → capped 2000
    });

    const r = await loadPeaks(PATH, never, deps);

    expect(r?.source).toBe("sidecar");
    expect(r?.duration).toBe(6);
    expect(r?.peaks).toBeInstanceOf(Float32Array);
    expect(deps.generateSidecar).toHaveBeenCalledWith(PATH, 2000);
    expect(deps.cache).toHaveBeenCalledWith(PATH, MTIME, expect.any(Float32Array), 6, 2000);
  });

  it("sidecar density falls back to the legacy 100/s when the element never reports", async () => {
    const deps = makeDeps({
      generateInProcess: vi.fn(async () => null),
      waitForElementDuration: vi.fn(async () => null),
    });

    await loadPeaks(PATH, never, deps);

    expect(deps.generateSidecar).toHaveBeenCalledWith(PATH, 100);
  });

  it("sidecar failure rejects (caller shows the failed state)", async () => {
    const deps = makeDeps({
      generateInProcess: vi.fn(async () => null),
      generateSidecar: vi.fn(async () => {
        throw new Error("daemon down");
      }),
    });

    await expect(loadPeaks(PATH, never, deps)).rejects.toThrow("daemon down");
  });
});

describe("loadPeaks cancellation checkpoints", () => {
  it("cancelled from the start: stops after mtime, reads nothing else", async () => {
    const deps = makeDeps();

    const r = await loadPeaks(PATH, () => true, deps);

    expect(r).toBeNull();
    expect(deps.getCached).not.toHaveBeenCalled();
    expect(deps.generateInProcess).not.toHaveBeenCalled();
  });

  it("cancelled during the cache lookup: no generation starts", async () => {
    let cancelled = false;
    const deps = makeDeps({
      getCached: vi.fn(async () => {
        cancelled = true;
        return null;
      }),
    });

    const r = await loadPeaks(PATH, () => cancelled, deps);

    expect(r).toBeNull();
    expect(deps.generateInProcess).not.toHaveBeenCalled();
  });

  it("mediabunny completes despite cancellation: result cached, return suppressed", async () => {
    let cancelled = false;
    const deps = makeDeps({
      generateInProcess: vi.fn(async () => {
        cancelled = true; // clip switched while decoding, decode finished anyway
        return mb({ duration: 7 });
      }),
    });

    const r = await loadPeaks(PATH, () => cancelled, deps);

    expect(r).toBeNull();
    expect(deps.cache).toHaveBeenCalledWith(PATH, MTIME, expect.any(Float32Array), 7, 2000);
    expect(deps.generateSidecar).not.toHaveBeenCalled();
  });

  it("mediabunny declines and cancellation lands before the sidecar: sidecar never runs", async () => {
    let cancelled = false;
    const deps = makeDeps({
      generateInProcess: vi.fn(async () => {
        cancelled = true;
        return null;
      }),
    });

    const r = await loadPeaks(PATH, () => cancelled, deps);

    expect(r).toBeNull();
    expect(deps.waitForElementDuration).not.toHaveBeenCalled();
    expect(deps.generateSidecar).not.toHaveBeenCalled();
  });

  it("sidecar completes despite cancellation: result cached, return suppressed", async () => {
    let cancelled = false;
    const deps = makeDeps({
      generateInProcess: vi.fn(async () => null),
      generateSidecar: vi.fn(async () => {
        cancelled = true;
        return { peaks: [0.3], duration: 6 };
      }),
    });

    const r = await loadPeaks(PATH, () => cancelled, deps);

    expect(r).toBeNull();
    expect(deps.cache).toHaveBeenCalledWith(PATH, MTIME, expect.any(Float32Array), 6, 2000);
  });
});
