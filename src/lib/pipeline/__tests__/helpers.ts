import type { Word, CaptionBlock } from "../../../types/project";

export function makeWords(
  text: string,
  options: { start?: number; wordDuration?: number; gap?: number; speaker?: string } = {},
): Word[] {
  const { start = 0.0, wordDuration = 0.3, gap = 0.05, speaker } = options;
  const words: Word[] = [];
  let t = start;
  for (const w of text.split(" ")) {
    words.push({ text: w, start: t, end: t + wordDuration, confidence: 1.0, speaker });
    t += wordDuration + gap;
  }
  return words;
}

export function makeBlock(
  index: number,
  start: number,
  end: number,
  lines: string[],
  words: Word[] = [],
): CaptionBlock {
  return { index, start, end, lines, words };
}
