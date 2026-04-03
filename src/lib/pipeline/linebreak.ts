import type { Phrase } from "./types";

const BREAK_AFTER_SENTENCE = 100;
const BREAK_AFTER_CLAUSE = 80;
const BREAK_BEFORE_CONJUNCTION = 60;
const BREAK_NEUTRAL = 40;
const BREAK_FORBIDDEN = -100;

const SENTENCE_ENDINGS = new Set([".", "?", "!"]);
const CLAUSE_PUNCTUATION = new Set([",", ";", ":", "\u2014", "--"]);

const CONJUNCTIONS = new Set([
  "and", "but", "or", "nor", "so", "yet",
  "that", "which", "who", "whom", "whose",
  "because", "although", "while", "when", "where", "if", "unless",
  "since", "until", "before", "after", "though",
  "however", "therefore", "meanwhile", "furthermore", "moreover",
]);

const ARTICLES_AND_DETERMINERS = new Set([
  "a", "an", "the", "this", "that", "these", "those",
  "my", "your", "his", "her", "its", "our", "their",
  "some", "any", "every", "each", "no",
]);

const PREPOSITIONS = new Set([
  "in", "on", "at", "to", "for", "with", "by", "from",
  "of", "about", "into", "through", "during", "between",
  "under", "over", "above", "below", "after", "before",
]);

const FORBIDDEN_LINE_ENDINGS = new Set([
  ...ARTICLES_AND_DETERMINERS,
  ...PREPOSITIONS,
]);

const MIN_WORDS_LINE2 = 2;

function scoreBreakPoint(words: string[], breakIndex: number): number {
  const before = words[breakIndex - 1];
  const after = words[breakIndex];

  if (before && SENTENCE_ENDINGS.has(before[before.length - 1])) return BREAK_AFTER_SENTENCE;
  if (before && CLAUSE_PUNCTUATION.has(before[before.length - 1])) return BREAK_AFTER_CLAUSE;
  if (before && before.endsWith("--")) return BREAK_AFTER_CLAUSE;
  if (after && CONJUNCTIONS.has(after.toLowerCase())) return BREAK_BEFORE_CONJUNCTION;
  if (before && FORBIDDEN_LINE_ENDINGS.has(before.toLowerCase().replace(/[,.;:]$/, ""))) {
    return BREAK_FORBIDDEN;
  }
  return BREAK_NEUTRAL;
}

/** Break a phrase into 1 or 2 display lines using linguistic scoring. */
export function breakIntoLines(phrase: Phrase, maxCharsPerLine = 42): string[] {
  const words = phrase.words.map((w) => w.text);

  if (words.length === 0) return [];

  const text = words.join(" ");
  if (words.length === 1 || text.length <= maxCharsPerLine) return [text];

  let bestBreak: number | null = null;
  let bestScore = -Infinity;

  for (let i = 1; i < words.length; i++) {
    const line1 = words.slice(0, i).join(" ");
    const line2 = words.slice(i).join(" ");
    const wordsLine2 = words.length - i;

    // Skip if line 2 would be an orphan
    if (wordsLine2 < MIN_WORDS_LINE2) continue;

    const overTarget =
      Math.max(0, line1.length - maxCharsPerLine) +
      Math.max(0, line2.length - maxCharsPerLine);

    let score = scoreBreakPoint(words, i);

    const balance = Math.abs(line1.length - line2.length);
    const total = line1.length + line2.length;
    const ratio = total > 0 ? Math.min(line1.length, line2.length) / total : 0.5;
    score -= ratio < 0.3 ? balance * 1.5 : balance * 0.5;
    score -= overTarget * 2;

    if (score > bestScore) {
      bestBreak = i;
      bestScore = score;
    }
  }

  if (bestBreak !== null) {
    return [
      words.slice(0, bestBreak).join(" "),
      words.slice(bestBreak).join(" "),
    ];
  }

  return [text];
}

/** Main entry point: break a phrase into caption lines, respecting max_lines. */
export function formatPhraseToCaptionLines(
  phrase: Phrase,
  maxCharsPerLine = 42,
  maxLines = 2,
): string[] {
  const lines = breakIntoLines(phrase, maxCharsPerLine);
  return lines.slice(0, maxLines);
}
