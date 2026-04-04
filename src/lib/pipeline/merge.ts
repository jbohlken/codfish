import type { MergeConfig } from "../../types/profile";
import { makePhrase, type Phrase } from "./types";

function canMerge(a: Phrase, b: Phrase, config: MergeConfig, maxMergedChars: number, maxMergedDuration: number): boolean {
  // Speaker change blocks merge
  const lastA = a.words[a.words.length - 1];
  const firstB = b.words[0];
  if (
    lastA?.speaker != null &&
    firstB?.speaker != null &&
    lastA.speaker !== firstB.speaker
  ) return false;

  // Gap too large
  if (b.start - a.end > config.mergeGapThreshold) return false;

  // Would exceed char limit
  if (a.charCount + 1 + b.charCount > maxMergedChars) return false;

  // Would exceed duration limit
  if (b.end - a.start > maxMergedDuration) return false;

  return true;
}

/** Merge short/orphan phrases with neighbors until stable. */
export function mergeShortPhrases(phrases: Phrase[], config: MergeConfig, maxMergedChars: number, maxMergedDuration: number): Phrase[] {
  if (phrases.length <= 1) return phrases;

  let changed = true;
  while (changed) {
    changed = false;
    const result: Phrase[] = [];
    let skipNext = false;

    for (let i = 0; i < phrases.length; i++) {
      if (skipNext) { skipNext = false; continue; }

      const phrase = phrases[i];
      const isShort = phrase.words.length < config.minSegmentWords;

      // Forward merge: combine this short phrase with the next
      if (isShort && i + 1 < phrases.length) {
        if (canMerge(phrase, phrases[i + 1], config, maxMergedChars, maxMergedDuration)) {
          result.push(makePhrase([...phrase.words, ...phrases[i + 1].words]));
          skipNext = true;
          changed = true;
          continue;
        }
      }

      // Backward merge: combine this short phrase into the previous
      if (isShort && result.length > 0) {
        const prev = result[result.length - 1];
        if (canMerge(prev, phrase, config, maxMergedChars, maxMergedDuration)) {
          result[result.length - 1] = makePhrase([...prev.words, ...phrase.words]);
          changed = true;
          continue;
        }
      }

      result.push(phrase);
    }

    phrases = result;
  }

  return phrases;
}
