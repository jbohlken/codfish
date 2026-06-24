/**
 * Bin (folder) logic for the project panel: the pure tree builder + selection
 * helpers, per-user collapse state (localStorage, not the .cod — so toggling
 * never enters undo history), and the undoable project mutations.
 *
 * Bins form an arbitrary-depth tree via Bin.parentId. Everything here is
 * defensive about malformed trees (missing parents, cycles) so a bad .cod can
 * never make bins vanish — orphans and cycle members surface at the top level.
 */

import { signal } from "@preact/signals";
import { project, pushHistory } from "../store/app";
import type { Bin, MediaItem } from "../types/project";
import type { SortMode, SortDir } from "./mediaSort";

// ── Tree model (pure) ──────────────────────────────────────────────────────

/** One node in the rendered bin forest: a bin, its child sub-bins (already
 *  ordered), and the media that live directly in it (input order preserved). */
export interface BinNode {
  bin: Bin;
  children: BinNode[];
  items: MediaItem[];
}

/** The whole displayable tree: top-level bins, then the media that belong to
 *  no (valid) bin. Mirrors the panel's layout — bins first, ungrouped after. */
export interface BinForest {
  roots: BinNode[];
  ungrouped: MediaItem[];
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Order a set of sibling bins by the active sort. Mirrors media's "added"
 * semantics: ISO `createdAt` compares chronologically, with the array index
 * folded in as the tiebreak so same-batch / legacy (un-stamped) bins keep a
 * stable order that still reverses with direction. "name" keeps an ascending
 * index tiebreak so identically-named bins don't flip. The input array's order
 * is the index source, so callers should pass siblings in their stored order.
 */
export function sortBins(bins: Bin[], mode: SortMode, dir: SortDir): Bin[] {
  const sign = dir === "desc" ? -1 : 1;
  const indexed = bins.map((bin, index) => ({ bin, index }));
  const compareAdded = (a: typeof indexed[number], b: typeof indexed[number]) => {
    const aAt = a.bin.createdAt;
    const bAt = b.bin.createdAt;
    if (aAt != null && bAt != null) return aAt < bAt ? -1 : aAt > bAt ? 1 : a.index - b.index;
    if (aAt == null && bAt == null) return a.index - b.index;
    return aAt == null ? -1 : 1;
  };
  const primary = (a: typeof indexed[number], b: typeof indexed[number]) =>
    mode === "name" ? nameCollator.compare(a.bin.name, b.bin.name) : compareAdded(a, b);
  return indexed
    .sort((a, b) => sign * primary(a, b) || a.index - b.index)
    .map((x) => x.bin);
}

/**
 * Build the displayable bin forest from already-ordered media and the project's
 * bins. Each level's sub-bins are ordered by `sortSiblings` (typically a
 * `sortBins` binding); media keep the order they arrive in (the caller's
 * sort/filter applies *within* a bin). `sortSiblings` receives one level's
 * bins at a time so its array-index tiebreak stays per-level.
 *
 * Defensive about malformed trees: a `parentId` that doesn't resolve (missing
 * bin, or self-reference) is treated as top-level, and any bins trapped in a
 * cycle are surfaced as roots too — so no bin is ever silently dropped. Media
 * whose `binId` is absent or references a missing bin fall into `ungrouped`.
 */
export function buildBinForest(
  media: MediaItem[],
  bins: Bin[],
  sortSiblings?: (bins: Bin[]) => Bin[],
): BinForest {
  const binById = new Map(bins.map((b) => [b.id, b]));

  // Adjacency in stored order; "" keys the top level. A parentId that can't be
  // resolved (or self-parents) is demoted to top-level.
  const childBins = new Map<string, Bin[]>();
  for (const b of bins) {
    const key = b.parentId && b.parentId !== b.id && binById.has(b.parentId) ? b.parentId : "";
    const arr = childBins.get(key);
    if (arr) arr.push(b);
    else childBins.set(key, [b]);
  }

  const mediaByBin = new Map<string, MediaItem[]>();
  const ungrouped: MediaItem[] = [];
  for (const m of media) {
    if (m.binId != null && binById.has(m.binId)) {
      const arr = mediaByBin.get(m.binId);
      if (arr) arr.push(m);
      else mediaByBin.set(m.binId, [m]);
    } else {
      ungrouped.push(m);
    }
  }

  const visited = new Set<string>();
  const build = (bin: Bin): BinNode => {
    visited.add(bin.id);
    let kids = (childBins.get(bin.id) ?? []).filter((c) => !visited.has(c.id));
    if (sortSiblings) kids = sortSiblings(kids);
    return { bin, children: kids.map(build), items: mediaByBin.get(bin.id) ?? [] };
  };

  let topLevel = childBins.get("") ?? [];
  if (sortSiblings) topLevel = sortSiblings(topLevel);
  const roots = topLevel.map(build);
  // Bins stuck in a cycle were never reached from the top level — surface them
  // as roots (the visited guard inside build() keeps the recursion finite).
  for (const b of bins) {
    if (!visited.has(b.id)) roots.push(build(b));
  }

  return { roots, ungrouped };
}

/** All bin ids in the subtree rooted at `rootId` (inclusive). Used by
 *  delete-bin to take the whole branch and by collapse hygiene. */
export function collectSubtree(bins: Bin[], rootId: string): Set<string> {
  const childrenOf = new Map<string, Bin[]>();
  for (const b of bins) {
    if (!b.parentId) continue;
    const arr = childrenOf.get(b.parentId);
    if (arr) arr.push(b);
    else childrenOf.set(b.parentId, [b]);
  }
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue; // cycle guard
    out.add(id);
    for (const c of childrenOf.get(id) ?? []) stack.push(c.id);
  }
  return out;
}

/** True when `nodeId` is `ancestorId` itself or nested anywhere beneath it.
 *  The reparent guard uses this to forbid moving a bin into its own subtree
 *  (which would orphan the branch into a cycle). Walks up from the node so a
 *  pre-existing cycle can't loop forever. */
export function isDescendant(bins: Bin[], ancestorId: string, nodeId: string): boolean {
  const byId = new Map(bins.map((b) => [b.id, b]));
  let cur: Bin | undefined = byId.get(nodeId);
  const seen = new Set<string>();
  while (cur) {
    if (cur.id === ancestorId) return true;
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
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

/** Drop persisted collapse state for the given bin ids (after they're dissolved
 *  or deleted) — localStorage hygiene; also means undoing the removal restores
 *  them expanded. No-op (no write) when none of the ids were collapsed. */
export function forgetBinCollapse(ids: string | Iterable<string>): void {
  const drop = typeof ids === "string" ? [ids] : [...ids];
  if (!drop.some((id) => collapsedBins.value.has(id))) return;
  const next = new Set(collapsedBins.value);
  for (const id of drop) next.delete(id);
  persistCollapsed(next);
}

// ── Mutations (undoable project edits) ────────────────────────────────────

/** Default "Bin N" name where N is one past the highest existing "Bin N", so
 *  dissolving a bin and creating a new one can't collide with a live name.
 *  Scans all bins (any depth) — names need only be unique enough to tell apart. */
function nextBinName(bins: Bin[]): string {
  let max = 0;
  for (const b of bins) {
    const m = /^Bin (\d+)$/.exec(b.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Bin ${max + 1}`;
}

function makeBin(bins: Bin[], name: string | undefined, parentId: string | undefined): Bin {
  return {
    id: crypto.randomUUID(),
    name: name?.trim() || nextBinName(bins),
    createdAt: new Date().toISOString(),
    ...(parentId ? { parentId } : {}),
  };
}

/** Create a bin and return its id (null if no project is open). Auto-names when
 *  no name is given. `parentId` nests it under an existing bin. */
export function createBin(name?: string, parentId?: string): string | null {
  const proj = project.value;
  if (!proj) return null;
  const bin = makeBin(proj.bins ?? [], name, parentId);
  pushHistory({ ...proj, bins: [...(proj.bins ?? []), bin] }, `New bin "${bin.name}"`);
  return bin.id;
}

/** Create a bin AND move the given media into it in ONE undo step, so the
 *  "New bin…" move gesture isn't two separate history entries. */
export function createBinWithMedia(mediaIds: string[], name?: string, parentId?: string): string | null {
  const proj = project.value;
  if (!proj) return null;
  const bin = makeBin(proj.bins ?? [], name, parentId);
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

/** Remove a bin, promoting its contents up one level: child sub-bins and direct
 *  media reparent to the dissolved bin's parent (or to top-level/ungrouped when
 *  it was a root). Files are kept. */
export function dissolveBin(id: string): void {
  const proj = project.value;
  if (!proj?.bins) return;
  const target = proj.bins.find((b) => b.id === id);
  if (!target) return;
  const newParent = target.parentId; // undefined => promote to top level / ungrouped
  pushHistory(
    {
      ...proj,
      bins: proj.bins
        .filter((b) => b.id !== id)
        .map((b) => (b.parentId === id ? { ...b, parentId: newParent } : b)),
      media: proj.media.map((m) => (m.binId === id ? { ...m, binId: newParent } : m)),
    },
    "Dissolve bin",
  );
  forgetBinCollapse(id);
}

/** Reparent a bin (or send it to the top level when `newParentId` is null).
 *  Refuses to move a bin into itself or any of its own descendants — that would
 *  orphan the branch into a cycle. No-op when the parent is unchanged. */
export function moveBin(binId: string, newParentId: string | null): void {
  const proj = project.value;
  if (!proj?.bins) return;
  const bin = proj.bins.find((b) => b.id === binId);
  if (!bin) return;
  const target = newParentId ?? undefined;
  if ((bin.parentId ?? undefined) === target) return; // no-op
  if (newParentId && isDescendant(proj.bins, binId, newParentId)) return; // would cycle
  pushHistory(
    { ...proj, bins: proj.bins.map((b) => (b.id === binId ? { ...b, parentId: target } : b)) },
    "Move bin",
  );
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
