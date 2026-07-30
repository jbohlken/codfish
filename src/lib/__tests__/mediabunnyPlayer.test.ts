import { describe, it, expect } from "vitest";
import { isRescue, type MediabunnyPlayer, type EngineRescue } from "../mediabunnyPlayer";

// Phase-3 routing is runtime-driven (the engine attempt IS the probe), so the
// real coverage lives in the battery's engine-smoke section. This pins the
// one pure piece: the discriminator VideoPanel branches on.
describe("isRescue", () => {
  it("discriminates rescue verdicts from players", () => {
    const verdicts: EngineRescue[] = [
      { rescue: "undecodable" },
      { rescue: "hdr" },
      { rescue: "error" },
    ];
    for (const v of verdicts) expect(isRescue(v)).toBe(true);
    expect(isRescue({ duration: 5, currentTime: () => 0 } as unknown as MediabunnyPlayer)).toBe(false);
  });
});
