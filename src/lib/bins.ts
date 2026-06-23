/**
 * Bin (folder) logic for the project panel: pure grouping/selection helpers,
 * per-user collapse state (localStorage, not the .cod — so toggling never
 * enters undo history), and the undoable project mutations.
 */

import { signal } from "@preact/signals";
import { project, pushHistory } from "../store/app";
import type { Bin, MediaItem } from "../types/project";

// ── Grouping (pure) ───────────────────────────────────────────────────────

export interface MediaGroup {
  /** null = the ungrouped section. */
  bin: Bin | null;
  items: MediaItem[];
}

/**
 * Partition already-ordered media into display groups: one per bin (in bins[]
 * order, empty bins included so they stay visible/usable), then a trailing
 * ungrouped group. Item order within each group is preserved from the input,
 * so the caller's sort/filter still applies *within* a bin. Media whose binId
 * is absent or references a missing bin falls into ungrouped. With no bins,
 * returns a single ungrouped group (the caller renders that as a flat list).
 */
export function groupMediaByBin(media: MediaItem[], bins: Bin[]): MediaGroup[] {
  if (bins.length === 0) {
    return media.length ? [{ bin: null, items: media }] : [];
  }
  const known = new Set(bins.map((b) => b.id));
  const byBin = new Map<string, MediaItem[]>();
  const ungrouped: MediaItem[] = [];
  for (const m of media) {
    if (m.binId != null && known.has(m.binId)) {
      const arr = byBin.get(m.binId);
      if (arr) arr.push(m);
      else byBin.set(m.binId, [m]);
    } else {
      ungrouped.push(m);
    }
  }
  const groups: MediaGroup[] = bins.map((bin) => ({ bin, items: byBin.get(bin.id) ?? [] }));
  if (ungrouped.length) groups.push({ bin: null, items: ungrouped });
  return groups;
}

/**
 * Inclusive range of ids between `anchorId` and `targetId` in display order
 * (for Shift-click selection). Falls back to just the target if either id
 * isn't in the list.
 */
export function rangeSelect(orderedIds: string[], anchorId: string, targetId: string): string[] {
  const a = orderedIds.indexOf(anchorId);
  const b = orderedIds.indexOf(targetId);
  if (a < 0 || b < 0) return [targetId];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return orderedIds.slice(lo, hi + 1);
}

// ── Collapse state (per-user view state, localStorage) ────────────────────

const COLLAPSED_KEY = "codfish:collapsedBins";

function loadCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

export const collapsedBins = signal<Set<string>>(loadCollapsed());

function persistCollapsed(next: Set<string>): void {
  collapsedBins.value = next;
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  } catch {
    // view state is best-effort
  }
}

export function toggleBinCollapsed(id: string): void {
  const next = new Set(collapsedBins.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  persistCollapsed(next);
}

/** Drop a bin's persisted collapse state (after it's dissolved or deleted) —
 *  localStorage hygiene; also means undoing the removal restores it expanded. */
export function forgetBinCollapse(id: string): void {
  if (!collapsedBins.value.has(id)) return;
  const next = new Set(collapsedBins.value);
  next.delete(id);
  persistCollapsed(next);
}

// ── Mutations (undoable project edits) ────────────────────────────────────

/** Default "Bin N" name where N is one past the highest existing "Bin N", so
 *  dissolving a bin and creating a new one can't collide with a live name. */
function nextBinName(bins: Bin[]): string {
  let max = 0;
  for (const b of bins) {
    const m = /^Bin (\d+)$/.exec(b.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Bin ${max + 1}`;
}

/** Create a bin and return its id (null if no project is open). Auto-names
 *  when no name is given. */
export function createBin(name?: string): string | null {
  const proj = project.value;
  if (!proj) return null;
  const bin: Bin = { id: crypto.randomUUID(), name: name?.trim() || nextBinName(proj.bins ?? []) };
  pushHistory({ ...proj, bins: [...(proj.bins ?? []), bin] }, `New bin "${bin.name}"`);
  return bin.id;
}

/** Create a bin AND move the given media into it in ONE undo step, so the
 *  "New bin…" move gesture isn't two separate history entries. */
export function createBinWithMedia(mediaIds: string[], name?: string): string | null {
  const proj = project.value;
  if (!proj) return null;
  const bin: Bin = { id: crypto.randomUUID(), name: name?.trim() || nextBinName(proj.bins ?? []) };
  const ids = new Set(mediaIds);
  pushHistory(
    {
      ...proj,
      bins: [...(proj.bins ?? []), bin],
      media: proj.media.map((m) => (ids.has(m.id) ? { ...m, binId: bin.id } : m)),
    },
    `New bin "${bin.name}"`,
  );
  return bin.id;
}

export function renameBin(id: string, name: string): void {
  const proj = project.value;
  const trimmed = name.trim();
  if (!proj?.bins || !trimmed) return;
  const bin = proj.bins.find((b) => b.id === id);
  if (!bin || bin.name === trimmed) return; // no-op: don't dirty / push history
  pushHistory(
    { ...proj, bins: proj.bins.map((b) => (b.id === id ? { ...b, name: trimmed } : b)) },
    "Rename bin",
  );
}

/** Remove a bin, returning its members to ungrouped (files are kept). */
export function dissolveBin(id: string): void {
  const proj = project.value;
  if (!proj?.bins) return;
  pushHistory(
    {
      ...proj,
      bins: proj.bins.filter((b) => b.id !== id),
      media: proj.media.map((m) => (m.binId === id ? { ...m, binId: undefined } : m)),
    },
    "Dissolve bin",
  );
  forgetBinCollapse(id);
}

/** Assign the given media to a bin (or ungroup them when binId is null). */
export function moveMediaToBin(mediaIds: string[], binId: string | null): void {
  const proj = project.value;
  if (!proj || mediaIds.length === 0) return;
  const ids = new Set(mediaIds);
  const target = binId ?? undefined;
  // No-op when every targeted item is already in the target bin.
  if (!proj.media.some((m) => ids.has(m.id) && (m.binId ?? undefined) !== target)) return;
  pushHistory(
    {
      ...proj,
      media: proj.media.map((m) => (ids.has(m.id) ? { ...m, binId: target } : m)),
    },
    binId ? "Move to bin" : "Remove from bin",
  );
}
