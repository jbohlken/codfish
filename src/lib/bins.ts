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
import { sortMedia, type SortMode, type SortDir } from "./mediaSort";

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
  // as roots, ordered like every other level (the visited guard inside build()
  // keeps the recursion finite).
  let stray = bins.filter((b) => !visited.has(b.id));
  if (sortSiblings) stray = sortSiblings(stray);
  for (const b of stray) {
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

/** Media ids in the order the project panel displays them: the bin forest
 *  flattened depth-first — a bin's sub-bins (and their clips) before the bin's
 *  own clips — then ungrouped clips, with the active sort applied at every
 *  level. Independent of collapse and search (those only hide rows). Used to
 *  order batch generation / bulk export so they follow what the user sees,
 *  rather than raw import order. */
export function orderMediaIdsForDisplay(
  media: MediaItem[],
  bins: Bin[],
  mode: SortMode,
  dir: SortDir,
): string[] {
  const forest = buildBinForest(sortMedia(media, mode, dir), bins, (level) => sortBins(level, mode, dir));
  const out: string[] = [];
  const visit = (node: BinNode) => {
    for (const child of node.children) visit(child);
    for (const m of node.items) out.push(m.id);
  };
  for (const root of forest.roots) visit(root);
  for (const m of forest.ungrouped) out.push(m.id);
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
// Bins default to COLLAPSED, so what's persisted is the set of EXPANDED ids per
// project — "no entry" therefore means all collapsed, and any bin not explicitly
// expanded (including ones created later) stays collapsed. The project key is
// its file path (so two on-disk copies of a .cod stay independent, and a
// save-as gets a fresh context), falling back to createdAt for an unsaved
// project. Persisted across sessions; never written to the .cod. `expanded` is
// recomputed from the live bin list on each write, so deleted bins drop out.
// The active project's collapsed set lives in `collapsedBins`.

const EXPANDED_KEY = "codfish:expandedBins";
// Bound localStorage growth: keep at most this many projects' entries, evicting
// the least-recently-written when exceeded.
const MAX_REMEMBERED_PROJECTS = 64;
// Retire the previous (collapsed-ids) storage so its inverted meaning can't be
// misread; collapse state resets once on upgrade (harmless view state).
try { localStorage.removeItem("codfish:collapsedBins"); } catch { /* ignore */ }

type ExpandedMap = Record<string, string[]>;

function loadExpandedMap(): ExpandedMap {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    // Keep only well-formed entries. We only ever write string[], but a
    // hand-edited / corrupt value that isn't an array of strings would crash
    // `new Set(value)` at the read site (e.g. `new Set(5)` throws), breaking the
    // panel's render — so sanitize here, at the single boundary all callers use.
    const clean: ExpandedMap = {};
    for (const [key, value] of Object.entries(raw)) {
      if (Array.isArray(value) && value.every((s) => typeof s === "string")) {
        clean[key] = value as string[];
      }
    }
    return clean;
  } catch {
    return {};
  }
}

let currentProjectKey: string | null = null;
export const collapsedBins = signal<Set<string>>(new Set());

function persistCollapsed(next: Set<string>): void {
  collapsedBins.value = next;
  if (currentProjectKey === null) return;
  try {
    const map = loadExpandedMap();
    // Delete-then-reinsert so this project moves to the most-recent (last)
    // insertion slot — the basis for LRU eviction below.
    delete map[currentProjectKey];
    // Store the expanded bins (the exceptions to the collapsed default),
    // recomputed from the current bin list so deleted bins fall away.
    const expanded = (project.peek()?.bins ?? []).map((b) => b.id).filter((id) => !next.has(id));
    if (expanded.length) map[currentProjectKey] = expanded;
    // Evict the oldest entries (front of insertion order) past the cap.
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_PROJECTS))) delete map[k];
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(map));
  } catch {
    // view state is best-effort
  }
}

/** Persist the current open/closed state as-is. Used right after creating a bin
 *  (which renders open by default): recording it now means the new bin is
 *  remembered open on reopen — what-you-see-is-what-you-get — instead of its
 *  open-ness only sticking if something is later toggled. */
export function rememberCollapseState(): void {
  persistCollapsed(collapsedBins.peek());
}

/** Swap the active collapse set to the given project's: every current bin
 *  (`validIds`) is collapsed unless it was saved as expanded. Call whenever the
 *  open project changes (null when none). */
export function loadCollapsedForProject(projectKey: string | null, validIds: Set<string>): void {
  currentProjectKey = projectKey;
  if (projectKey === null) {
    collapsedBins.value = new Set();
    return;
  }
  const expanded = new Set(loadExpandedMap()[projectKey] ?? []);
  collapsedBins.value = new Set([...validIds].filter((id) => !expanded.has(id)));
}

export function toggleBinCollapsed(id: string): void {
  const next = new Set(collapsedBins.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  persistCollapsed(next);
}

/** Force a bin open (e.g. after adding a sub-bin to it, so the new child is
 *  visible). No-op when it isn't collapsed. */
export function expandBin(id: string): void {
  if (!collapsedBins.value.has(id)) return;
  const next = new Set(collapsedBins.value);
  next.delete(id);
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

/** Copy a project's remembered bin-collapse state to a new storage key, keeping
 *  the original. Save As writes a copy at a new path while the original file
 *  still exists, so both keep their state; moving would wipe the original's on
 *  reopen. The active key follows to the new project. Mirrors copyClipViewProject. */
export function copyBinCollapseProject(oldKey: string, newKey: string): void {
  if (oldKey === newKey) return;
  try {
    const map = loadExpandedMap();
    const entry = map[oldKey];
    if (entry) {
      // Delete-then-reinsert newKey so it lands in the most-recent LRU slot.
      delete map[newKey];
      map[newKey] = [...entry];
      const keys = Object.keys(map);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_PROJECTS))) delete map[k];
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(map));
    }
  } catch {
    // view state is best-effort
  }
  if (currentProjectKey === oldKey) currentProjectKey = newKey;
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

/** Build a Bin object (id + createdAt, auto-named if no name) without touching
 *  history — for callers that batch a bin into a larger pushHistory. */
export function makeBin(bins: Bin[], name: string | undefined, parentId: string | undefined): Bin {
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
  rememberCollapseState(); // the new bin is open — remember it open across sessions
  return bin.id;
}

/** Create a bin AND move a selection of clips and/or bins into it in ONE undo
 *  step, so the "New bin…" gesture isn't two separate history entries. Uses the
 *  same selection-as-a-block rules as {@link moveItemsToBin} (a selected bin
 *  whose ancestor is also selected, or a clip inside a selected bin, travels
 *  with its parent). Returns the new bin's id. */
export function createBinWithItems(mediaIds: string[], binIds: string[], parentId?: string): string | null {
  const proj = project.value;
  if (!proj) return null;
  const bin = makeBin(proj.bins ?? [], undefined, parentId);
  const allBins = [...(proj.bins ?? []), bin];
  const { reparentBinIds, moveMediaIds } = planItemMove(allBins, proj.media, mediaIds, binIds, bin.id);
  const reparent = new Set(reparentBinIds);
  const moveMedia = new Set(moveMediaIds);
  pushHistory(
    {
      ...proj,
      bins: allBins.map((b) => (reparent.has(b.id) ? { ...b, parentId: bin.id } : b)),
      media: proj.media.map((m) => (moveMedia.has(m.id) ? { ...m, binId: bin.id } : m)),
    },
    `New bin "${bin.name}"`,
  );
  rememberCollapseState(); // the new bin is open — remember it open across sessions
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

/**
 * Pure planner for {@link dissolveBins}: drop the dissolved bins and promote
 * everything they held up to the nearest *surviving* ancestor (or top level).
 * Handles dissolving a parent and child together — contents skip past every
 * dissolved ancestor in one go. Exposed for unit tests.
 */
export function planDissolve(
  allBins: Bin[],
  media: MediaItem[],
  dissolveIds: string[],
): { bins: Bin[]; media: MediaItem[] } {
  const dissolve = new Set(dissolveIds);
  const byId = new Map(allBins.map((b) => [b.id, b]));
  // Walk up from a parent id past any dissolved bins to the first survivor
  // (undefined = top level / ungrouped).
  const survivingParent = (parentId?: string): string | undefined => {
    let cur = parentId;
    const seen = new Set<string>();
    while (cur && dissolve.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = byId.get(cur)?.parentId;
    }
    return cur && !dissolve.has(cur) ? cur : undefined;
  };
  return {
    bins: allBins
      .filter((b) => !dissolve.has(b.id))
      .map((b) => (b.parentId != null && dissolve.has(b.parentId) ? { ...b, parentId: survivingParent(b.parentId) } : b)),
    media: media.map((m) => (m.binId != null && dissolve.has(m.binId) ? { ...m, binId: survivingParent(m.binId) } : m)),
  };
}

/** Remove one or more bins, promoting their contents up to the nearest
 *  surviving ancestor (or top level). Files are kept. */
export function dissolveBins(binIds: string[]): void {
  const proj = project.value;
  if (!proj?.bins || binIds.length === 0) return;
  const { bins, media } = planDissolve(proj.bins, proj.media, binIds);
  pushHistory({ ...proj, bins, media }, binIds.length > 1 ? `Dissolve ${binIds.length} bins` : "Dissolve bin");
  forgetBinCollapse(binIds);
}

/**
 * Pure planner for {@link moveItemsToBin}: decide which selected bins actually
 * reparent and which selected clips actually move, given the current tree.
 * Exposed (and unit-tested) because the selection-as-a-block rules are subtle:
 *  - A selected bin whose ancestor is also selected travels inside that
 *    ancestor (it isn't reparented on its own).
 *  - A selected clip inside a selected bin travels with the bin (not yanked out
 *    to the target).
 *  - Bins can't move into themselves or their own subtree (cycle), and no-op
 *    moves are dropped.
 */
export function planItemMove(
  allBins: Bin[],
  media: MediaItem[],
  mediaIds: string[],
  binIds: string[],
  targetBinId: string | null,
): { reparentBinIds: string[]; moveMediaIds: string[] } {
  const byId = new Map(allBins.map((b) => [b.id, b]));
  const target = targetBinId ?? undefined;
  const selectedBins = new Set(binIds);

  const hasSelectedAncestor = (id: string): boolean => {
    const seen = new Set<string>();
    let cur = byId.get(id)?.parentId;
    while (cur && !seen.has(cur)) {
      if (selectedBins.has(cur)) return true;
      seen.add(cur);
      cur = byId.get(cur)?.parentId;
    }
    return false;
  };

  // Bins to actually reparent: selected, no selected ancestor (those travel
  // inside it), not a no-op, and not into their own subtree (cycle).
  const reparentBinIds = binIds.filter((id) => {
    const bin = byId.get(id);
    if (!bin || hasSelectedAncestor(id)) return false;
    if ((bin.parentId ?? undefined) === target) return false;
    if (targetBinId && isDescendant(allBins, id, targetBinId)) return false;
    return true;
  });
  // Clips to move: selected, not already in target, and not inside a selected
  // bin (those travel with their bin).
  const mediaById = new Map(media.map((m) => [m.id, m]));
  const moveMediaIds = mediaIds.filter((id) => {
    const m = mediaById.get(id);
    if (!m) return false;
    if (m.binId != null && selectedBins.has(m.binId)) return false;
    return (m.binId ?? undefined) !== target;
  });
  return { reparentBinIds, moveMediaIds };
}

/** Move a mixed selection of clips and bins to a target bin (or the top level
 *  when null) in ONE undo step — for drag-and-drop. Defers the selection-as-a-
 *  block and cycle/no-op decisions to {@link planItemMove}; if nothing would
 *  change, history isn't touched. */
export function moveItemsToBin(mediaIds: string[], binIds: string[], targetBinId: string | null): void {
  const proj = project.value;
  if (!proj) return;
  const target = targetBinId ?? undefined;
  const { reparentBinIds, moveMediaIds } = planItemMove(proj.bins ?? [], proj.media, mediaIds, binIds, targetBinId);
  if (!reparentBinIds.length && !moveMediaIds.length) return;
  const reparent = new Set(reparentBinIds);
  const moveMedia = new Set(moveMediaIds);
  pushHistory(
    {
      ...proj,
      bins: (proj.bins ?? []).map((b) => (reparent.has(b.id) ? { ...b, parentId: target } : b)),
      media: proj.media.map((m) => (moveMedia.has(m.id) ? { ...m, binId: target } : m)),
    },
    targetBinId ? "Move to bin" : "Move to top level",
  );
  // Reveal where the items landed — a collapsed target would otherwise hide
  // them. expandBin persists, so the bin stays open across sessions.
  if (targetBinId) expandBin(targetBinId);
}
