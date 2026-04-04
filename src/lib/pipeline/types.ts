import type { Word } from "../../types/project";

/** A group of words forming a natural caption-sized unit (pipeline-internal). */
export interface Phrase {
  words: Word[];
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly duration: number;
  readonly charCount: number;
}

export function makePhrase(words: Word[]): Phrase {
  return {
    words,
    get text() { return words.map((w) => w.text).join(" "); },
    get start() { return words[0].start; },
    get end() { return words[words.length - 1].end; },
    get duration() { return words[words.length - 1].end - words[0].start; },
    get charCount() { return words.map((w) => w.text).join(" ").length; },
  };
}

export type ValidationRule =
  | "max_lines"
  | "chars_per_line"
  | "min_duration"
  | "max_duration"
  | "reading_speed"
  | "gap_flicker"
  | "line_balance"
  | "overlap";

export interface ValidationWarning {
  blockIndex: number;
  rule: ValidationRule;
  message: string;
  label: string;   // short problem name, e.g. "Too short"
  detail: string;  // concise values, e.g. "0.45s — min 1s"
  actualValue: number;
  targetValue: number;
  strict?: boolean; // true = firm violation, false/undefined = fuzzy guideline
}

export interface ValidationReport {
  totalBlocks: number;
  warnings: ValidationWarning[];
}
