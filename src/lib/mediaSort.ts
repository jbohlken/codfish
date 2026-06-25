/**
 * Pure sort logic for the project panel's media list. Kept out of the
 * component so the ordering invariants (which are correctness- and
 * format-stability-sensitive) can be unit-tested directly.
 */

import type { MediaItem } from "../types/project";

export type SortMode = "added" | "name";
export type SortDir = "asc" | "desc";

export const SORT_MODES: SortMode[] = ["added", "name"];
export const SORT_DIRS: SortDir[] = ["asc", "desc"];

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

interface Indexed { item: MediaItem; index: number; }

/**
 * "Added" comparison — a TOTAL order, with the import index folded in as the
 * final key. ISO timestamps compare lexicographically = chronologically. A
 * legacy item with no `addedAt` predates any stamped one (stamping began at a
 * single app version and media is append-only). For items the timestamp can't
 * separate — two legacy items, or a same-batch import sharing a timestamp —
 * the import index decides, and because it's part of the *primary* order it
 * reverses with direction. (That's the point: for legacy media the array
 * index is the only "when added" signal there is, so "Newest first" must flip
 * it.) Relink doesn't stamp addedAt, so a mid-array unstamped item can't arise
 * today; if that changes the unstamped-before-stamped rule needs revisiting.
 */
function compareAdded(a: Indexed, b: Indexed): number {
  const aAt = a.item.addedAt;
  const bAt = b.item.addedAt;
  if (aAt != null && bAt != null) return aAt < bAt ? -1 : aAt > bAt ? 1 : a.index - b.index;
  if (aAt == null && bAt == null) return a.index - b.index;
  return aAt == null ? -1 : 1;
}

function primaryCompare(mode: SortMode, a: Indexed, b: Indexed): number {
  return mode === "name"
    ? nameCollator.compare(a.item.name, b.item.name)
    : compareAdded(a, b);
}

/**
 * Sort a copy of `media`. The primary key follows `dir`.
 *
 * - "added" is a total order (timestamp, then import index), so direction
 *   reverses the whole list — including legacy/unstamped media, whose import
 *   order is their only added-order signal. Default "added" + "asc" reproduces
 *   the media array order exactly.
 * - "name" keeps a stable ASCENDING import-order tiebreak for equal keys, so
 *   identically-named items hold their relative order in both directions
 *   instead of flipping.
 */
export function sortMedia(media: MediaItem[], mode: SortMode, dir: SortDir): MediaItem[] {
  const sign = dir === "desc" ? -1 : 1;
  return media
    .map((item, index) => ({ item, index }))
    .sort((a, b) => sign * primaryCompare(mode, a, b) || a.index - b.index)
    .map((x) => x.item);
}
