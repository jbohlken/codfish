/** A parameter that can be enforced strictly or treated as a fuzzy target. */
export interface ProfileRule<T> {
  value: T;
  strict: boolean; // true = pipeline enforces, false = warn only
}

/** A timing parameter that can be expressed in seconds or frames. */
export interface TimedRule {
  value: number;
  strict: boolean;
  unit: "s" | "fr";
}

export interface TimingConfig {
  minDuration: TimedRule;
  maxDuration: TimedRule;
  maxCps: ProfileRule<number>;        // characters per second (reading speed)
  extendToFill: boolean;
  extendToFillMax: number;            // seconds
  gapCloseThreshold: number;          // seconds — gaps below this are closed (seamless)
  minGapEnabled: boolean;
  minGapSeconds: TimedRule;
  defaultFps: number;
}

export interface FormattingConfig {
  maxCharsPerLine: ProfileRule<number>;
  maxLines: ProfileRule<number>;
}

export interface MergeConfig {
  enabled: boolean;
  phraseBreakGap: number;             // seconds — silence gap that forces a new segment
  minSegmentWords: number;
  mergeGapThreshold: number;          // seconds
}

export interface CaptionProfile {
  id: string;
  name: string;
  builtIn: boolean;
  timing: TimingConfig;
  formatting: FormattingConfig;
  merge: MergeConfig;
}
