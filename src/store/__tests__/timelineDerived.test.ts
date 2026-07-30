// Derived-state contracts for the mediabunny probe integration: the
// timelineDuration precedence chain, the detectedFps/timelineFps chain every
// selected-clip surface shares, stepPlayhead's fps fallback, and — the
// regression the adversarial review demanded — that probedInfo survives
// same-path project rewrites (caption edits clone MediaItems; an effect keyed
// on object identity flapped the filmstrip and extent on every trim-drag
// pointermove).
import { describe, it, expect, beforeEach } from "vitest";
import {
  project,
  selectedMediaId,
  probedInfo,
  mediaDuration,
  waveformAudioDuration,
  timelineDuration,
  detectedFps,
  timelineFps,
  stepPlayhead,
  playbackTime,
  isPlaying,
  profiles,
  selectedProfile,
} from "../app";
import type { CodProject, MediaItem } from "../../types/project";
import type { CaptionProfile } from "../../types/profile";
import type { MediaProbe } from "../../lib/mediaProbe";

function makeProfile(): CaptionProfile {
  return {
    id: "test",
    name: "Test",
    description: "",
    builtIn: false,
    timing: {
      minDuration: { value: 0.5, strict: true, unit: "s" },
      maxDuration: { value: 6, strict: true, unit: "s" },
      maxCps: { value: 20, strict: false },
      extendToFill: false,
      extendToFillMax: 0.5,
      gapCloseThreshold: 0.5,
      minGapEnabled: true,
      minGapSeconds: { value: 0.4, strict: true, unit: "s" },
      defaultFps: 24,
      ...{},
    },
    formatting: {
      maxCharsPerLine: { value: 42, strict: false },
      maxLines: { value: 2, strict: true },
    },
    merge: { enabled: false, phraseBreakGap: 0.7, minSegmentWords: 3, mergeGapThreshold: 0.5 },
  };
}

function makeMedia(over: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "m1",
    name: "clip.mp4",
    path: "C:\\media\\clip.mp4",
    fps: null,
    captions: [],
    ...over,
  };
}

function makeProject(media: MediaItem[]): CodProject {
  return {
    version: 1,
    name: "t",
    transcriptionModel: "base" as CodProject["transcriptionModel"],
    language: "en",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    media,
  };
}

const probe = (over: Partial<MediaProbe> = {}): MediaProbe => ({
  duration: 0,
  hasVideo: true,
  hasAudio: true,
  fps: null,
  vfr: false,
  canDecodeVideo: true,
  canDecodeAudio: true,
  aspect: 16 / 9,
  ...over,
});

function openClip(media: MediaItem): void {
  project.value = makeProject([media]);
  selectedMediaId.value = media.id;
}

beforeEach(() => {
  profiles.value = [makeProfile()];
  selectedProfile.value = "Test";
  project.value = null;
  selectedMediaId.value = null;
  probedInfo.value = null;
  mediaDuration.value = 0;
  waveformAudioDuration.value = 0;
  playbackTime.value = 0;
  isPlaying.value = false;
});

describe("timelineDuration precedence", () => {
  it("probed duration beats the element clock for video", () => {
    openClip(makeMedia());
    mediaDuration.value = 6.016; // element over-estimate
    probedInfo.value = probe({ duration: 6.0 });
    expect(timelineDuration.value).toBe(6.0);
  });

  it("probed duration beats the decoded audio length for audio-only", () => {
    openClip(makeMedia({ name: "a.mp3", path: "C:\\media\\a.mp3" }));
    waveformAudioDuration.value = 5.041;
    probedInfo.value = probe({ duration: 5.04, hasVideo: false });
    expect(timelineDuration.value).toBe(5.04);
  });

  it("falls back audio→decoded length, video→element clock, then caption end", () => {
    openClip(makeMedia({ name: "a.mp3", path: "C:\\media\\a.mp3" }));
    waveformAudioDuration.value = 5.04;
    expect(timelineDuration.value).toBe(5.04);

    openClip(makeMedia());
    mediaDuration.value = 12;
    expect(timelineDuration.value).toBe(12);

    // In the app the Timeline resets waveformAudioDuration on clip switch;
    // this suite bypasses the component, so reset it by hand.
    mediaDuration.value = 0;
    waveformAudioDuration.value = 0;
    openClip(makeMedia({ captions: [{ index: 0, start: 0, end: 3.5, lines: ["x"] }] }));
    expect(timelineDuration.value).toBe(3.5);
  });
});

describe("detectedFps / timelineFps chain", () => {
  it("persisted media.fps wins over the probe", () => {
    openClip(makeMedia({ fps: 30 }));
    probedInfo.value = probe({ fps: 23.976 });
    expect(detectedFps.value).toBe(30);
    expect(timelineFps.value).toBe(30);
  });

  it("probed fps fills in when the sidecar never ran", () => {
    openClip(makeMedia({ fps: null }));
    probedInfo.value = probe({ fps: 23.976 });
    expect(detectedFps.value).toBe(23.976);
    expect(timelineFps.value).toBe(23.976);
  });

  it("profile default is last resort — and detectedFps stays null", () => {
    openClip(makeMedia({ fps: null }));
    expect(detectedFps.value).toBeNull();
    expect(timelineFps.value).toBe(24);
  });
});

describe("stepPlayhead", () => {
  it("steps on the probed frame grid when media.fps is null", () => {
    openClip(makeMedia({ fps: null }));
    probedInfo.value = probe({ fps: 10, duration: 5 });
    playbackTime.value = 1;
    stepPlayhead(1);
    expect(playbackTime.value).toBeCloseTo(1.1, 10);
    stepPlayhead(-1);
    expect(playbackTime.value).toBeCloseTo(1.0, 10);
  });

  it("clamps to the probed duration", () => {
    openClip(makeMedia({ fps: null }));
    probedInfo.value = probe({ fps: 10, duration: 5 });
    playbackTime.value = 4.95;
    stepPlayhead(1);
    expect(playbackTime.value).toBe(5);
  });
});

describe("probe effect keying (the trim-drag flap regression)", () => {
  it("probedInfo survives a same-path project rewrite (caption edit clone)", () => {
    const media = makeMedia();
    openClip(media);
    probedInfo.value = probe({ duration: 6 });

    // Every caption edit rebuilds MediaItem objects with the same path — the
    // effect must NOT refire (it is keyed on the path primitive).
    const proj = project.value!;
    project.value = {
      ...proj,
      media: proj.media.map((m) => ({ ...m, captions: [...m.captions] })),
    };

    expect(probedInfo.value).not.toBeNull();
    expect(timelineDuration.value).toBe(6);
  });

  it("probedInfo resets when the selected clip actually changes", () => {
    openClip(makeMedia());
    probedInfo.value = probe({ duration: 6 });

    const other = makeMedia({ id: "m2", path: "C:\\media\\other.mp4" });
    project.value = makeProject([makeMedia(), other]);
    selectedMediaId.value = "m2";

    expect(probedInfo.value).toBeNull();
  });
});
