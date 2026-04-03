/** A parameter that can be enforced strictly or treated as a fuzzy target. */
export interface ProfileRule<T> {
  value: T;
  strict: boolean; // true = pipeline enforces, false = warn only
}

export interface TimingConfig {
  minDuration: ProfileRule<number>;   // seconds
  maxDuration: ProfileRule<number>;   // seconds
  extendToFill: boolean;
  extendToFillMax: number;            // seconds
  gapCloseThreshold: number;          // seconds — gaps below this are closed (seamless)
  minGapSeconds: number;              // seconds — minimum non-zero gap (prevents flicker)
  defaultFps: number;
}

export interface FormattingConfig {
  maxCharsPerLine: ProfileRule<number>;
  maxLines: number;                   // always strict — never has fuzzy mode
  maxCps: ProfileRule<number>;        // characters per second (reading speed)
}

export interface MergeConfig {
  enabled: boolean;
  minSegmentWords: number;
  mergeGapThreshold: number;          // seconds
  maxMergedChars: number;
  maxMergedDuration: number;          // seconds
}

export interface CaptionProfile {
  id: string;
  name: string;
  builtIn: boolean;
  timing: TimingConfig;
  formatting: FormattingConfig;
  merge: MergeConfig;
}
