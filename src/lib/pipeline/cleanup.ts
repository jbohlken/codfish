import type { Word } from "../../types/project";

function shouldMergeWithPrevious(prev: Word, curr: Word): boolean {
  const p = prev.text;
  const c = curr.text;

  // Hyphen compounds: "out" + "-of" → "out-of"
  if (c.startsWith("-") && p.length > 0 && /[a-zA-Z]$/.test(p)) return true;

  // Comma in numbers: "$8" + ",000" → "$8,000"
  if (/^,\d/.test(c) && p.length > 0 && /\d$/.test(p)) return true;

  // Period in numbers: "$2" + ".5" → "$2.5"
  if (/^\.\d/.test(c) && p.length > 0 && /\d$/.test(p)) return true;

  // Percent/degree after number: "100" + "%" → "100%"
  if ((c === "%" || c === "°") && p.length > 0 && /\d$/.test(p)) return true;

  // Currency prefix: "$" + "8" → "$8"
  if (["$", "£", "€"].includes(p) && c.length > 0 && /^\d/.test(c)) return true;

  // Contractions: "don" + "'t" → "don't"
  if (c.startsWith("'") && p.length > 0 && /[a-zA-Z]$/.test(p)) return true;

  // Colon in times: "2" + ":00" → "2:00"
  if (/^:\d/.test(c) && p.length > 0 && /\d$/.test(p)) return true;

  // Slash joining: "and" + "/or" → "and/or"
  if (c.startsWith("/") && p.length > 0 && /[a-zA-Z]$/.test(p)) return true;

  return false;
}

function mergeWords(prev: Word, curr: Word): Word {
  return {
    text: prev.text + curr.text,
    start: prev.start,
    end: curr.end,
    confidence: Math.min(prev.confidence, curr.confidence),
    speaker: prev.speaker,
  };
}

/** Fix Whisper BPE tokenization artifacts by merging adjacent tokens that belong together. */
export function cleanWords(words: Word[]): Word[] {
  if (words.length === 0) return [];

  const result: Word[] = [words[0]];

  for (let i = 1; i < words.length; i++) {
    const curr = words[i];
    const prev = result[result.length - 1];
    if (shouldMergeWithPrevious(prev, curr)) {
      result[result.length - 1] = mergeWords(prev, curr);
    } else {
      result.push(curr);
    }
  }

  return result;
}
