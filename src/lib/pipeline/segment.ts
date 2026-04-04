import type { Word } from "../../types/project";
import { makePhrase, type Phrase } from "./types";

const SENTENCE_ENDINGS = new Set([".", "?", "!"]);
const CLAUSE_BREAKS = new Set([",", ";", ":", "\u2014", "--"]);
const PHRASE_BREAK_WORDS = new Set([
  // Coordinating conjunctions
  "and", "but", "or", "nor", "so", "yet",
  // Relative pronouns
  "that", "which", "who", "whom", "whose",
  // Subordinating conjunctions
  "because", "although", "while", "when", "where", "if", "unless",
  "since", "until", "before", "after", "though",
  // Conjunctive adverbs
  "however", "therefore", "meanwhile", "furthermore", "moreover",
]);

function endsWithPunct(text: string, set: Set<string>): boolean {
  if (!text) return false;
  if (set.has(text[text.length - 1])) return true;
  if (text.length >= 2 && set.has(text.slice(-2))) return true;
  return false;
}

export function segmentIntoPhrases(
  words: Word[],
  options: {
    maxChars?: number;
    maxLines?: number;
    maxWordsPerPhrase?: number;
    maxDuration?: number;
    gapThreshold?: number;            // seconds — silence gap that forces a new segment
  } = {},
): Phrase[] {
  const {
    maxChars = 42,
    maxLines = 2,
    maxWordsPerPhrase = 15,
    maxDuration = 6.0,
    gapThreshold = 0.7, // seconds — silence gap that forces a new segment
  } = options;

  if (words.length === 0) return [];

  const phrases: Phrase[] = [];
  let current: Word[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    current.push(word);
    const currentText = current.map((w) => w.text).join(" ");
    let shouldBreak = false;

    // (a) Sentence ending
    if (endsWithPunct(word.text, SENTENCE_ENDINGS)) shouldBreak = true;

    if (i + 1 < words.length) {
      const next = words[i + 1];
      const nextText = currentText + " " + next.text;

      // (b) Would exceed the full line budget
      if (nextText.length > maxChars * maxLines) shouldBreak = true;

      // (c) Duration limit
      if (next.end - current[0].start > maxDuration) shouldBreak = true;

      // (d) Speaker change
      if (
        word.speaker != null &&
        next.speaker != null &&
        word.speaker !== next.speaker
      ) shouldBreak = true;

      // (e) Time gap
      if (next.start - word.end > gapThreshold) shouldBreak = true;

      // (f) Word count limit
      if (current.length >= maxWordsPerPhrase) shouldBreak = true;

      // Prefer to break at clause/phrase boundaries when getting long
      if (currentText.length > maxChars * 0.6) {
        if (endsWithPunct(word.text, CLAUSE_BREAKS)) shouldBreak = true;
        if (PHRASE_BREAK_WORDS.has(next.text.toLowerCase())) shouldBreak = true;
      }
    } else {
      // Last word
      shouldBreak = true;
    }

    if (shouldBreak && current.length > 0) {
      phrases.push(makePhrase([...current]));
      current = [];
    }
  }

  return phrases;
}
