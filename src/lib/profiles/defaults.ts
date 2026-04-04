import type { CaptionProfile } from "../../types/profile";

function rule<T>(value: T, strict = false) {
  return { value, strict };
}

function timed(value: number, strict = false, unit: "s" | "fr" = "s") {
  return { value, strict, unit };
}

export const DEFAULT_PROFILES: CaptionProfile[] = [
  {
    id: "default",
    name: "Default",
    builtIn: true,
    timing: {
      minDuration: timed(1.0),
      maxDuration: timed(6.0),
      maxCps: rule(20.0),
      extendToFill: true,
      extendToFillMax: 0.5,
      gapCloseThreshold: 0.5,
      minGapEnabled: true,
      minGapSeconds: timed(0.4, true),
      defaultFps: 30.0,
    },
    formatting: {
      maxCharsPerLine: rule(42),
      maxLines: rule(2),
    },
    merge: {
      enabled: true,
      phraseBreakGap: 0.7,
      minSegmentWords: 5,
      mergeGapThreshold: 0.6,
    },
  },
  {
    id: "jellyvision",
    name: "Jellyvision",
    builtIn: true,
    timing: {
      minDuration: timed(1.0),
      maxDuration: timed(6.0),
      maxCps: rule(20.0),
      extendToFill: true,
      extendToFillMax: 0.5,
      gapCloseThreshold: 0.5,
      minGapEnabled: true,
      minGapSeconds: timed(0.4, true),
      defaultFps: 30.0,
    },
    formatting: {
      maxCharsPerLine: rule(42),
      maxLines: rule(2),
    },
    merge: {
      enabled: true,
      phraseBreakGap: 0.7,
      minSegmentWords: 5,
      mergeGapThreshold: 0.6,
    },
  },
  {
    id: "netflix",
    name: "Netflix",
    builtIn: true,
    timing: {
      minDuration: timed(20, false, "fr"),
      maxDuration: timed(7.0),
      maxCps: rule(20.0),
      extendToFill: true,
      extendToFillMax: 0.5,
      gapCloseThreshold: 0.5,
      minGapEnabled: true,
      minGapSeconds: timed(2, true, "fr"),
      defaultFps: 23.976,
    },
    formatting: {
      maxCharsPerLine: rule(42),
      maxLines: rule(2),
    },
    merge: {
      enabled: true,
      phraseBreakGap: 0.7,
      minSegmentWords: 5,
      mergeGapThreshold: 0.5,
    },
  },
  {
    id: "bbc",
    name: "BBC",
    builtIn: true,
    timing: {
      minDuration: timed(1.0),
      maxDuration: timed(5.5),
      maxCps: rule(17.0),
      extendToFill: true,
      extendToFillMax: 0.4,
      gapCloseThreshold: 0.4,
      minGapEnabled: true,
      minGapSeconds: timed(0.4, true),
      defaultFps: 25.0,
    },
    formatting: {
      maxCharsPerLine: rule(37),
      maxLines: rule(2),
    },
    merge: {
      enabled: true,
      phraseBreakGap: 0.7,
      minSegmentWords: 4,
      mergeGapThreshold: 0.5,
    },
  },
];
