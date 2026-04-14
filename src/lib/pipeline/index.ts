import type { Word, CaptionBlock } from "../../types/project";
import type { CaptionProfile } from "../../types/profile";
import { toSeconds } from "../time";
import { cleanWords } from "./cleanup";
import { segmentIntoPhrases } from "./segment";
import { mergeShortPhrases } from "./merge";
import { formatPhraseToCaptionLines } from "./linebreak";
import { enforceTiming } from "./timing";
import { validate } from "./validate";
import type { ValidationReport } from "./types";

export interface PipelineResult {
  captions: CaptionBlock[];
  report: ValidationReport;
}

/**
 * Run the full 6-stage caption pipeline on a list of transcribed words.
 *
 * Stages:
 * 1. Cleanup   — fix Whisper BPE tokenization artifacts
 * 2. Segment   — group words into phrase-sized chunks
 * 3. Merge     — combine short/orphan phrases
 * 4. Linebreak — break phrases into 1–2 display lines
 * 5. Timing    — FPS frame-snapping, extend-to-fill, gap enforcement
 * 6. Validate  — produce warnings for spec violations
 */
export function runPipeline(
  words: Word[],
  profile: CaptionProfile,
  sourceFps?: number,
): PipelineResult {
  // 1. Cleanup
  const cleanedWords = cleanWords(words);

  const fps = sourceFps ?? profile.timing.defaultFps;
  const maxDurationSec = toSeconds(profile.timing.maxDuration, fps);

  // 2. Segment
  const phrases = segmentIntoPhrases(cleanedWords, {
    maxChars: profile.formatting.maxCharsPerLine.value,
    maxLines: profile.formatting.maxLines.value,
    maxDuration: maxDurationSec,
    gapThreshold: profile.merge.phraseBreakGap,
  });

  // 3. Merge — char and duration budgets derived from display capacity
  const maxMergedChars = profile.formatting.maxCharsPerLine.value * profile.formatting.maxLines.value;
  const mergedPhrases = profile.merge.enabled
    ? mergeShortPhrases(phrases, profile.merge, maxMergedChars, maxDurationSec)
    : phrases;

  // 4. Linebreak → CaptionBlocks (up to maxLines lines per caption)
  const blocks: CaptionBlock[] = mergedPhrases.map((phrase, i) => ({
    index: i + 1,
    start: phrase.start,
    end: phrase.end,
    lines: formatPhraseToCaptionLines(
      phrase,
      profile.formatting.maxCharsPerLine.value,
      profile.formatting.maxLines.value,
    ),
    speaker: phrase.words[0]?.speaker,
    words: phrase.words,
  }));

  // 5. Timing
  enforceTiming(blocks, profile.timing, sourceFps);

  // 6. Validate
  const report = validate(blocks, profile, sourceFps);

  // Strip words from blocks before returning (not persisted to project file)
  const captions: CaptionBlock[] = blocks.map(({ words: _words, ...rest }) => rest);

  return { captions, report };
}

export { cleanWords } from "./cleanup";
export { segmentIntoPhrases } from "./segment";
export { mergeShortPhrases } from "./merge";
export { formatPhraseToCaptionLines, breakIntoLines, breakTextIntoLines } from "./linebreak";
export { enforceTiming, snapToFrame, framesBetween } from "./timing";
export { validate } from "./validate";
export type { PipelineResult as default };
export type { ValidationReport, ValidationWarning } from "./types";
