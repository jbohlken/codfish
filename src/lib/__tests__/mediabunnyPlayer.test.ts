import { describe, it, expect } from "vitest";
import { needsEngine } from "../mediabunnyPlayer";
import type { MediaProbe } from "../mediaProbe";

const probe = (over: Partial<MediaProbe> = {}): MediaProbe => ({
  duration: 5,
  hasVideo: true,
  hasAudio: true,
  fps: 30,
  vfr: false,
  videoCodec: "avc",
  canDecodeVideo: true,
  canDecodeAudio: true,
  aspect: 16 / 9,
  ...over,
});

describe("needsEngine (phase-2 routing: element default)", () => {
  it("routes element-rejected containers unconditionally, probe or not", () => {
    expect(needsEngine("C:\\media\\a.mkv", null)).toBe(true);
    expect(needsEngine("C:\\media\\a.m4a", null)).toBe(true);
    expect(needsEngine("/mnt/media/A.MKV", probe())).toBe(true); // case-insensitive
  });

  it("routes ProRes .mov to the engine only when WebCodecs can decode it", () => {
    expect(needsEngine("C:\\media\\a.mov", probe({ videoCodec: "prores" }))).toBe(true);
    // Undecodable ProRes: the element's audio-with-black-frame beats a dead engine.
    expect(needsEngine("C:\\media\\a.mov", probe({ videoCodec: "prores", canDecodeVideo: false }))).toBe(false);
  });

  it("keeps the element for everything it plays today", () => {
    expect(needsEngine("C:\\media\\a.mp4", probe())).toBe(false);
    expect(needsEngine("C:\\media\\a.mov", probe({ videoCodec: "hevc" }))).toBe(false);
    expect(needsEngine("C:\\media\\a.webm", probe({ videoCodec: "vp9" }))).toBe(false);
    expect(needsEngine("C:\\media\\a.mp3", probe({ hasVideo: false, videoCodec: null }))).toBe(false);
  });

  it("defaults to the element while the probe is still pending", () => {
    expect(needsEngine("C:\\media\\a.mov", null)).toBe(false);
  });
});
