import type { CaptionProfile } from "../../types/profile";

function rule<T>(value: T, strict = false) {
  return { value, strict };
}

export const DEFAULT_PROFILES: CaptionProfile[] = [
  {
    id: "default",
    name: "Default",
    builtIn: true,
    timing: {
      minDuration: rule(1.0),
      maxDuration: rule(6.0),
      extendToFill: true,
      extendToFillMax: 0.5,
      gapCloseThreshold: 0.5,
      minGapSeconds: 0.4,
      defaultFps: 30.0,
    },
    formatting: {
      maxCharsPerLine: rule(42),
      maxLines: 2,
      maxCps: rule(20.0),
    },
    merge: {
      enabled: true,
      minSegmentWords: 5,
      mergeGapThreshold: 0.6,
      maxMergedChars: 84,
      maxMergedDuration: 6.0,
    },
  },
  {
    id: "jellyvision",
    name: "Jellyvision",
    builtIn: true,
    timing: {
      minDuration: rule(1.0),
      maxDuration: rule(6.0),
      extendToFill: true,
      extendToFillMax: 0.5,
      gapCloseThreshold: 0.5,
      minGapSeconds: 0.4,
      defaultFps: 30.0,
    },
    formatting: {
      maxCharsPerLine: rule(42),
      maxLines: 2,
      maxCps: rule(20.0),
    },
    merge: {
      enabled: true,
      minSegmentWords: 5,
      mergeGapThreshold: 0.6,
      maxMergedChars: 84,
      maxMergedDuration: 6.0,
    },
  },
  {
    id: "netflix",
    name: "Netflix",
    builtIn: true,
    timing: {
      minDuration: rule(0.833),
      maxDuration: rule(7.0),
      extendToFill: true,
      extendToFillMax: 0.5,
      gapCloseThreshold: 0.5,
      minGapSeconds: 0.2,
      defaultFps: 23.976,
    },
    formatting: {
      maxCharsPerLine: rule(42),
      maxLines: 2,
      maxCps: rule(20.0),
    },
    merge: {
      enabled: true,
      minSegmentWords: 5,
      mergeGapThreshold: 0.5,
      maxMergedChars: 84,
      maxMergedDuration: 7.0,
    },
  },
  {
    id: "bbc",
    name: "BBC",
    builtIn: true,
    timing: {
      minDuration: rule(1.0),
      maxDuration: rule(5.5),
      extendToFill: true,
      extendToFillMax: 0.4,
      gapCloseThreshold: 0.4,
      minGapSeconds: 0.4,
      defaultFps: 25.0,
    },
    formatting: {
      maxCharsPerLine: rule(37),
      maxLines: 2,
      maxCps: rule(17.0),
    },
    merge: {
      enabled: true,
      minSegmentWords: 4,
      mergeGapThreshold: 0.5,
      maxMergedChars: 74,
      maxMergedDuration: 5.5,
    },
  },
];
