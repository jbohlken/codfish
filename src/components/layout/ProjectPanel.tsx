import { useEffect, useRef, useState, useMemo } from "preact/hooks";
import { FilmSlateIcon as FilmSlate, MusicNoteIcon as MusicNote, WarningCircleIcon as WarningCircle, PlusIcon as Plus, FilePlusIcon as FilePlus, FolderOpenIcon as FolderOpen, FolderIcon as Folder, FolderPlusIcon as FolderPlus, ArrowsDownUpIcon as ArrowsDownUp, CheckIcon as Check, MagnifyingGlassIcon as MagnifyingGlass, XIcon as X } from "@phosphor-icons/react";
import type { ComponentChildren } from "preact";
import { signal, computed, useComputed } from "@preact/signals";
import { project, projectPath, selectedMediaId, selectedMediaIds, selectedBinIds, selectedCaptionIndex, pushHistory, deselectAll } from "../../store/app";
import {
  newProjectGuarded,
  openProjectGuarded,
  openRecent,
  importMedia,
  importDrop,
  relinkMediaItem,
  fileExists,
  VIDEO_EXTS,
} from "../../lib/project";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  buildBinForest,
  sortBins,
  collectSubtree,
  isDescendant,
  rangeSelect,
  collapsedBins,
  loadCollapsedForProject,
  toggleBinCollapsed,
  expandBin,
  createBin,
  createBinWithItems,
  renameBin,
  dissolveBins,
  moveItemsToBin,
  forgetBinCollapse,
  type BinNode,
} from "../../lib/bins";
import { recentProjects } from "../../lib/recent";
import { showContextMenu, type ContextMenuEntry } from "../ContextMenu";
import { hideTooltip } from "../Tooltip";
import { confirmUnsavedChanges } from "../UnsavedChanges";
import { mediaSettingsId } from "../MediaSettings";
import { sortMedia, type SortMode, type SortDir } from "../../lib/mediaSort";
import type { MediaItem, Bin } from "../../types/project";

const missingIds = signal<ReadonlySet<string>>(new Set());

// Pixels each bin-tree nesting level shifts its rows to the right — one icon
// (14px) + the row's flex gap (--space-2, 8px), so a child's icon sits under
// its parent's name. Bins and media share this one formula and have the same
// [icon][name] layout (a bin's open/closed folder icon doubles as its
// disclosure control), so the two row kinds align with no extra gutter — and a
// top-level clip never shifts just because a bin was added.
const BIN_INDENT_STEP = 22;

// ── Drag-and-drop ─────────────────────────────────────────────────────────
// What's currently being dragged, and the live drop target for highlighting.
// Module-level signals so the row components can read them without prop drilling
// (the actual move logic stays in ProjectPanel, where `bins` is in scope).
type DragPayload = { mediaIds: string[]; binIds: string[] };
const dragPayload = signal<DragPayload | null>(null);
// dropTarget holds the hovered bin's id, ROOT_DROP for the top-level area, or
// null for "no valid target under the cursor".
const ROOT_DROP = "__root__";
const dropTarget = signal<string | null>(null);

// Floating label that follows the cursor during a pointer-based row drag (a
// small pill — "Clip name" or "N items"). Pointer-events:none (in CSS) so it
// never intercepts the elementFromPoint hit-test that finds the drop target.
// The caller positions it on each pointermove and removes it when the drag ends.
function createDragGhost(label: string): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  ghost.textContent = label;
  document.body.appendChild(ghost);
  return ghost;
}

// Resolve an OS file-drop position (physical px, from Tauri's drag-drop event)
// to a target in the project panel: a bin (its data-bin-id), the panel itself
// (ROOT_DROP = top level), or null when the drop is outside the panel or no
// project is open. Reuses the same hit-test shape as the in-app pointer drag.
function osDropTargetAt(pos: { x: number; y: number }): string | null {
  if (!project.peek()) return null;
  const dpr = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr) as HTMLElement | null;
  if (!el) return null;
  const binEl = el.closest("[data-bin-id]");
  if (binEl) return binEl.getAttribute("data-bin-id");
  return el.closest(".project-panel") ? ROOT_DROP : null;
}

// ── Panel resizing ──────────────────────────────────────────────────────────
// The grid column is driven by --project-panel-width; dragging the handle
// overrides it inline on <html> and persists per-user. Double-click resets
// to the stylesheet default.

const PANEL_WIDTH_KEY = "codfish:projectPanelWidth";
const PANEL_WIDTH_MIN = 180;
const PANEL_WIDTH_MAX = 560;

function applyPanelWidth(px: number | null) {
  const root = document.documentElement;
  if (px === null) root.style.removeProperty("--project-panel-width");
  else root.style.setProperty("--project-panel-width", `${px}px`);
}

function PanelResizeHandle() {
  useEffect(() => {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= PANEL_WIDTH_MIN && stored <= PANEL_WIDTH_MAX) {
      // Re-apply the same half-window cap the drag enforces, so a width saved
      // on a wide monitor can't swallow a narrower window on next launch.
      applyPanelWidth(Math.min(stored, Math.round(window.innerWidth / 2)));
    }
    // Safety net: if the handle unmounts mid-drag (onUp never fires), don't
    // leave the global drag cursor / text-selection lock stuck on <body>.
    return () => document.body.classList.remove("col-resizing");
  }, []);

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const handle = e.currentTarget as HTMLElement;
    // The handle lives in the panel header, which spans the panel's full
    // width — so its width is the panel width.
    const host = handle.parentElement;
    if (!host) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("col-resizing");

    const startX = e.clientX;
    const startWidth = host.getBoundingClientRect().width;
    let width = startWidth;

    const onMove = (ev: PointerEvent) => {
      // Never let the panel eat more than half the window, even on small screens
      const max = Math.min(PANEL_WIDTH_MAX, Math.round(window.innerWidth / 2));
      width = Math.max(PANEL_WIDTH_MIN, Math.min(max, startWidth + (ev.clientX - startX)));
      applyPanelWidth(width);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("col-resizing");
      localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(width)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      class="panel-resize-handle"
      onPointerDown={onPointerDown}
      onDblClick={() => {
        applyPanelWidth(null);
        localStorage.removeItem(PANEL_WIDTH_KEY);
      }}
    />
  );
}

// ── Sort & filter ───────────────────────────────────────────────────────────
// Sort mode/direction are user-level view state (persisted in localStorage,
// not the .cod). Filter text is transient and resets on project switch. The
// ordering itself lives in lib/mediaSort (pure + unit-tested).

const SORT_MODE_KEY = "codfish:projectSortMode";
const SORT_DIR_KEY = "codfish:projectSortDir";
const SORT_MODES: SortMode[] = ["added", "name"];
const SORT_DIRS: SortDir[] = ["asc", "desc"];

const SORT_LABELS: Record<SortMode, string> = {
  added: "Date added",
  name: "Name",
};
const DIR_LABELS: Record<SortMode, Record<SortDir, string>> = {
  added: { asc: "Oldest first", desc: "Newest first" },
  name: { asc: "A → Z", desc: "Z → A" },
};

const storedMode = localStorage.getItem(SORT_MODE_KEY) as SortMode | null;
const storedDir = localStorage.getItem(SORT_DIR_KEY) as SortDir | null;
const sortMode = signal<SortMode>(storedMode && SORT_MODES.includes(storedMode) ? storedMode : "added");
const sortDir = signal<SortDir>(storedDir && SORT_DIRS.includes(storedDir) ? storedDir : "asc");
const filterText = signal("");
// Search is hidden behind a header button; the filter row only renders while
// open. It opens focused and closes when it loses focus while empty (or on
// Escape / project switch). Closing always clears the query so there's never
// a hidden filter.
const searchOpen = signal(false);

// Which row should show the "open in editor" marker: the open clip's own row
// when it's visible, or — when that clip is hidden inside a collapsed bin — the
// shallowest collapsed ancestor standing in for it (that bin's row is the one
// actually rendered). null when nothing is open. Read per-row in the class
// computeds (so it never re-renders the forest), the same way selection/drop are.
const openIndicatorId = computed<string | null>(() => {
  const openId = selectedMediaId.value;
  if (!openId) return null;
  // Searching force-expands the tree and filters the list, so collapse-ancestor
  // logic is moot — just mark the open clip's own row if it's in the results.
  if (filterText.value.trim().length > 0) return openId;
  const proj = project.value;
  const clip = proj?.media.find((m) => m.id === openId);
  if (!clip?.binId) return openId; // ungrouped, or not found → its own row
  // Walk the bin-ancestor chain (innermost → outermost); the outermost collapsed
  // one is the visible stand-in. If none are collapsed, the clip's row shows.
  const binById = new Map((proj?.bins ?? []).map((b) => [b.id, b]));
  const collapsed = collapsedBins.value;
  const chain: string[] = [];
  const seen = new Set<string>();
  let bid: string | undefined = clip.binId;
  while (bid && binById.has(bid) && !seen.has(bid)) {
    seen.add(bid);
    chain.push(bid);
    bid = binById.get(bid)!.parentId;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    if (collapsed.has(chain[i])) return chain[i];
  }
  return openId;
});

// The project key (createdAt) the filter was last reset for. Module-level so
// it survives ProjectPanel remounts — see the reset block below.
let lastFilterResetKey: string | null | undefined = undefined;

function openSearch() {
  searchOpen.value = true;
}
function closeSearch() {
  searchOpen.value = false;
  filterText.value = "";
}

// Shift-click range anchor (the last plain/ctrl click) and the bin currently
// being inline-renamed in its header.
const selectionAnchor = signal<string | null>(null);
const editingBinId = signal<string | null>(null);

function setSortMode(mode: SortMode) {
  sortMode.value = mode;
  localStorage.setItem(SORT_MODE_KEY, mode);
}
function setSortDir(dir: SortDir) {
  sortDir.value = dir;
  localStorage.setItem(SORT_DIR_KEY, dir);
}

/** Apply the active sort + filter to a media array, as the panel displays it.
 *  Shared by the render and by removeMediaIds' selection fallback so both
 *  agree on "visible order". */
function visibleOrder(media: MediaItem[]): MediaItem[] {
  const q = filterText.value.trim().toLowerCase();
  return sortMedia(media, sortMode.value, sortDir.value)
    .filter((m) => !q || m.name.toLowerCase().includes(q));
}

/** Header dropdown: pick sort field + direction. Positioned fixed (computed
 *  from the trigger rect) so it escapes the panel's overflow:hidden clip. No
 *  layout ancestor uses transform, so viewport coords are correct. The
 *  captured position can't track the trigger, so anything that could move it
 *  (window resize, scroll, panel-width drag) just closes the menu. */
function SortMenu() {
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const open = pos !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    // pointerdown (not mousedown) so a panel-resize drag — which calls
    // preventDefault and would suppress the compat mousedown — still dismisses.
    // The menu is a DOM child of `ref` even though it's position:fixed, so
    // contains() correctly treats in-menu clicks as inside.
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) { setPos(null); return; }
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
  };

  const mode = sortMode.value;
  const dir = sortDir.value;

  return (
    <div class="panel-sort" ref={ref}>
      <button
        ref={btnRef}
        class="btn btn-ghost btn-icon"
        data-tooltip="Sort media"
        onClick={toggle}
      >
        <ArrowsDownUp size={14} />
      </button>
      {pos && (
        <div class="panel-sort-menu" style={{ top: `${pos.top}px`, right: `${pos.right}px` }}>
          <div class="panel-sort-group-label">Sort by</div>
          {SORT_MODES.map((m) => (
            <button
              key={m}
              class={`panel-sort-option${m === mode ? " panel-sort-option--active" : ""}`}
              onClick={() => setSortMode(m)}
            >
              <span class="panel-sort-check">{m === mode && <Check size={13} />}</span>
              <span>{SORT_LABELS[m]}</span>
            </button>
          ))}
          <div class="panel-sort-divider" />
          {SORT_DIRS.map((d) => (
            <button
              key={d}
              class={`panel-sort-option${d === dir ? " panel-sort-option--active" : ""}`}
              onClick={() => setSortDir(d)}
            >
              <span class="panel-sort-check">{d === dir && <Check size={13} />}</span>
              <span>{DIR_LABELS[mode][d]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

async function checkMissingMedia(items: MediaItem[]) {
  if (items.length === 0) {
    missingIds.value = new Set();
    return;
  }
  const results = await Promise.all(
    items.map(async (m) => ({ id: m.id, missing: !(await fileExists(m.path)) }))
  );
  missingIds.value = new Set(results.filter((r) => r.missing).map((r) => r.id));
}

function removeMediaIds(mediaIds: string[], opts?: { removeBinIds?: string[]; label?: string; visibleOrderIds?: string[] }) {
  const proj = project.value;
  const removeBinIds = opts?.removeBinIds;
  if (!proj || (mediaIds.length === 0 && !removeBinIds?.length)) return;
  const removing = new Set(mediaIds);
  const active = selectedMediaId.value;
  const removingActive = active !== null && removing.has(active);
  // When removing the active item, move selection to the nearest surviving
  // neighbour in the order the panel actually shows. Callers pass the
  // reveal-aware visible order (so a clip surfaced by a bin-name search match —
  // whose own name doesn't match the query — is included); falls back to the
  // name-filtered flat order.
  let nextId = active;
  if (removingActive) {
    const order = opts?.visibleOrderIds ?? visibleOrder(proj.media).map((m) => m.id);
    const pos = order.findIndex((mid) => removing.has(mid));
    const after = order.slice(pos + 1).find((mid) => !removing.has(mid));
    const before = pos > 0 ? [...order.slice(0, pos)].reverse().find((mid) => !removing.has(mid)) : undefined;
    nextId = after ?? before ?? null;
  }
  const updated = proj.media.filter((m) => !removing.has(m.id));
  const label = opts?.label ?? (mediaIds.length > 1 ? `Remove ${mediaIds.length} media` : "Remove media");
  // Record the post-op selection so redo lands on the neighbour, not a
  // now-deleted id — pushHistory otherwise snapshots the current selection.
  const dropBins = removeBinIds && removeBinIds.length ? new Set(removeBinIds) : null;
  pushHistory(
    {
      ...proj,
      media: updated,
      ...(dropBins ? { bins: (proj.bins ?? []).filter((b) => !dropBins.has(b.id)) } : {}),
    },
    label,
    { selectedMediaId: nextId, selectedCaptionIndex: selectedCaptionIndex.value },
  );
  if (removingActive) selectedMediaId.value = nextId;
}

export function ProjectPanel() {
  const proj = project.value;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const panelBodyRef = useRef<HTMLDivElement>(null);
  // Teardown for an in-flight pointer drag, so an unmount mid-drag can cancel it.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  useEffect(() => {
    checkMissingMedia(proj?.media ?? []);
  }, [proj?.media]);

  // Focus the search field when it opens.
  useEffect(() => {
    if (searchOpen.value) searchInputRef.current?.focus();
  }, [searchOpen.value]);

  // OS file drop: dropping media files from the desktop onto the panel imports
  // them (into a bin if dropped on one, else ungrouped). Tauri's window-level
  // drag-drop gives real filesystem paths; we hit-test the drop position to
  // scope it to the panel and reuse dropTarget for the same highlight as the
  // in-app drag. Guarded so it's a no-op outside a Tauri webview (e.g. tests).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "leave") {
            dropTarget.value = null;
          } else if (p.type === "drop") {
            const target = osDropTargetAt(p.position);
            dropTarget.value = null;
            if (target !== null) void importDrop(p.paths, target === ROOT_DROP ? undefined : target);
          } else {
            // enter / over
            dropTarget.value = osDropTargetAt(p.position);
          }
        })
        .then((un) => { if (disposed) un(); else unlisten = un; })
        .catch(() => {});
    } catch {
      // not running in a Tauri webview
    }
    return () => { disposed = true; unlisten?.(); };
  }, []);

  // Clear any leftover filter when a different project is opened — a stale
  // query that hides everything in the new project would be confusing. Keyed
  // on createdAt (stable within a project, differs across them), guarded by a
  // module-level marker so it fires only on a genuine project change — not on
  // every remount (e.g. a daemon-crash splash), which would wipe an in-progress
  // filter even though the project never changed. Done inline during render
  // (before `query` is read) rather than in an effect, so the new project
  // never renders one frame filtered by the old query.
  // Identity is the file path (so two on-disk copies of a .cod, and a save-as,
  // are distinct view-state contexts), falling back to createdAt for an unsaved
  // project. Drives both the filter reset and the per-project collapse load.
  const projectKey = proj ? (projectPath.value ?? proj.createdAt) : null;
  if (projectKey !== lastFilterResetKey) {
    lastFilterResetKey = projectKey;
    searchOpen.value = false;
    filterText.value = "";
    // Switching projects keeps this panel mounted, so clear per-project view
    // state that would otherwise bleed across: a mid-rename, the shift anchor,
    // and any in-flight drag. (selection sets are reset by the load path.)
    editingBinId.value = null;
    selectionAnchor.value = null;
    dragPayload.value = null;
    dropTarget.value = null;
    // Load this project's saved bin collapse state (pruned to its current
    // bins). Inline like the filter reset, so the first frame already reflects
    // the right state rather than flashing all-expanded.
    loadCollapsedForProject(projectKey, new Set((proj?.bins ?? []).map((b) => b.id)));
  }

  // Closed search never filters, even if filterText somehow lingers.
  const query = searchOpen.value ? filterText.value.trim().toLowerCase() : "";
  const hasMedia = (proj?.media.length ?? 0) > 0;
  const media = proj?.media;
  const sMode = sortMode.value;
  const sDir = sortDir.value;
  const bins = proj?.bins ?? [];
  const hasBins = bins.length > 0;
  const searching = query.length > 0;

  // Search matches clip names AND bin names. A matched bin reveals its whole
  // sub-tree — every clip and sub-bin inside shows regardless of their own
  // names — so `revealedBins` is the matched bins plus everything under them.
  // A clip also shows on its own name match. Sort + filter together so the
  // sort runs once per change, not per re-render.
  const { visibleMedia, revealedBins } = useMemo(() => {
    if (!media) return { visibleMedia: [] as MediaItem[], revealedBins: new Set<string>() };
    const sorted = sortMedia(media, sMode, sDir);
    if (!query) return { visibleMedia: sorted, revealedBins: new Set<string>() };
    const revealed = new Set<string>();
    for (const b of bins) {
      if (b.name.toLowerCase().includes(query)) {
        for (const x of collectSubtree(bins, b.id)) revealed.add(x);
      }
    }
    const vm = sorted.filter(
      (m) => m.name.toLowerCase().includes(query) || (m.binId != null && revealed.has(m.binId)),
    );
    return { visibleMedia: vm, revealedBins: revealed };
  }, [media, bins, sMode, sDir, query]);

  const showSearch = !!proj && hasMedia && searchOpen.value;

  // Selection and drop highlights are bound per-row to computed signals (see
  // MediaRow/BinGroup) rather than read here — so selecting or dragging updates
  // only the affected row's class attribute and never re-renders the forest.
  // The root drop highlight and the new-bin tooltip read their signals the same
  // way, keeping this render off the dropTarget/selection subscription list.
  const panelBodyClass = useComputed(
    () => `panel-body scrollable${dropTarget.value === ROOT_DROP ? " panel-body--drop-root" : ""}`,
  );
  const newBinTooltip = useComputed(() => (selectedBinIds.value.size === 1 ? "New sub-bin" : "New bin"));
  // Sub-bins at each level follow the same sort as media; media keep the
  // already-sorted order they arrive in. Bins first, then ungrouped media.
  const forest = buildBinForest(visibleMedia, bins, (level) => sortBins(level, sMode, sDir));
  const collapsedSet = collapsedBins.value;
  const isCollapsed = (binId: string) => !searching && collapsedSet.has(binId);

  // While searching, a bin shows when it (or a sub-bin) was name-matched, when
  // it holds a revealed clip, or when it's on the path to one — so a match is
  // always reachable. revealedBins already covers matched bins + their contents.
  // Precomputed once in a single post-order pass (and only while searching), so
  // the per-node check is an O(1) lookup rather than a subtree re-walk at each
  // of its two call sites (collectVisible + renderNode).
  const shownBins = new Set<string>();
  if (searching) {
    const mark = (node: BinNode): boolean => {
      let shown = revealedBins.has(node.bin.id) || node.items.length > 0;
      for (const c of node.children) if (mark(c)) shown = true; // visit all, don't short-circuit
      if (shown) shownBins.add(node.bin.id);
      return shown;
    };
    forest.roots.forEach(mark);
  }
  const binShown = (node: BinNode): boolean => shownBins.has(node.bin.id);

  // Direct item count per bin for its row badge: clips plus sub-bins (a bin is
  // an item too). Counted from the full project, not the filtered view, and
  // direct children only — like a file explorer's "N items".
  const binCounts = new Map<string, number>();
  const bumpCount = (id: string) => binCounts.set(id, (binCounts.get(id) ?? 0) + 1);
  for (const mm of proj?.media ?? []) {
    if (mm.binId != null) bumpCount(mm.binId);
  }
  for (const b of bins) {
    if (b.parentId != null) bumpCount(b.parentId);
  }

  // Rows actually on screen, in display order (the bin row, then its sub-bins
  // and media when expanded), so a shift-range / drag selection never pulls in
  // rows hidden inside a collapsed (or search-hidden) bin. Each row carries its
  // kind so a range can mix clips and bins.
  const orderedRows: { id: string; kind: "media" | "bin" }[] = [];
  const collectVisible = (nodes: BinNode[]) => {
    for (const node of nodes) {
      if (searching && !binShown(node)) continue;
      orderedRows.push({ id: node.bin.id, kind: "bin" });
      if (isCollapsed(node.bin.id)) continue;
      collectVisible(node.children);
      for (const m of node.items) orderedRows.push({ id: m.id, kind: "media" });
    }
  };
  collectVisible(forest.roots);
  for (const m of forest.ungrouped) orderedRows.push({ id: m.id, kind: "media" });
  const orderedRowIds = orderedRows.map((r) => r.id);
  const rowKind = new Map(orderedRows.map((r) => [r.id, r.kind] as const));

  // Bins flattened in display (tree) order with their nesting depth — the
  // source for the "Move to bin" pickers, which indent each entry by depth so
  // the hierarchy reads in a single flat list (deep flyout chains don't).
  const orderedBinList: { bin: Bin; depth: number }[] = [];
  const flattenBins = (nodes: BinNode[], depth: number) => {
    for (const n of nodes) {
      orderedBinList.push({ bin: n.bin, depth });
      flattenBins(n.children, depth + 1);
    }
  };
  flattenBins(forest.roots, 0);

  // Selection. Plain click selects just the row; Ctrl/Cmd toggles it; Shift
  // extends a range over the visible order from the anchor. Clips and bins live
  // in separate sets (selectedMediaIds / selectedBinIds) but select together, so
  // a shift-range can span both. selectedMediaId — the clip the editor follows —
  // only moves when a clip is the target, so selecting bins leaves the editor
  // on its last clip.
  // Select exactly one row (ignoring modifiers) — the plain-click behaviour,
  // also used when a drag grabs a row outside the current selection.
  const selectOnly = (id: string, kind: "media" | "bin") => {
    if (kind === "media") {
      selectedMediaId.value = id;
      selectedMediaIds.value = new Set([id]);
      selectedBinIds.value = new Set();
    } else {
      selectedBinIds.value = new Set([id]);
      selectedMediaIds.value = new Set();
    }
    selectionAnchor.value = id;
  };

  const selectRowId = (id: string, kind: "media" | "bin", e: MouseEvent) => {
    if (e.shiftKey && selectionAnchor.value) {
      const range = rangeSelect(orderedRowIds, selectionAnchor.value, id);
      selectedMediaIds.value = new Set(range.filter((rid) => rowKind.get(rid) === "media"));
      selectedBinIds.value = new Set(range.filter((rid) => rowKind.get(rid) === "bin"));
      if (kind === "media") selectedMediaId.value = id;
    } else if (e.ctrlKey || e.metaKey) {
      if (kind === "media") {
        const next = new Set(selectedMediaIds.peek());
        if (next.has(id)) next.delete(id);
        else next.add(id);
        selectedMediaIds.value = next;
        if (next.has(id)) selectedMediaId.value = id;
        else {
          // Removed the active clip — move the editor to another still-selected
          // clip so the selection stays coherent: prefer a visible one, else any
          // in the set (e.g. one inside a collapsed bin). If no clip remains,
          // leave the editor on its last clip — same as a bins-only selection
          // (nulling it here would wrongly clear any co-selected bins via the
          // coherence effect).
          const visible = orderedRows.find((r) => r.kind === "media" && next.has(r.id));
          const fallback = visible?.id ?? next.values().next().value;
          if (fallback) selectedMediaId.value = fallback;
        }
      } else {
        const next = new Set(selectedBinIds.peek());
        if (next.has(id)) next.delete(id);
        else next.add(id);
        selectedBinIds.value = next;
      }
      selectionAnchor.value = id;
    } else {
      selectOnly(id, kind);
    }
  };
  const selectRow = (item: MediaItem, e: MouseEvent) => selectRowId(item.id, "media", e);

  // Phrase a clip+bin count, e.g. "2 clips", "1 bin", "2 clips and 1 bin".
  const countLabel = (clips: number, bins_: number): string => {
    const parts: string[] = [];
    if (clips) parts.push(`${clips} clip${clips === 1 ? "" : "s"}`);
    if (bins_) parts.push(`${bins_} bin${bins_ === 1 ? "" : "s"}`);
    return parts.join(" and ") || "0 items";
  };

  // "Move to…" submenu for a selection of clips and/or bins: Top level (when
  // anything is currently nested) → the bin tree → New bin…. Targets exclude
  // any selected bin and anything inside one (a bin can't move into its own
  // subtree). "New bin…" creates a bin and moves the whole selection into it.
  const buildMoveSubmenu = (mediaIds: string[], binIds: string[]): ContextMenuEntry[] => {
    // When everything selected already shares one parent bin, moving there is a
    // no-op — show it greyed-out (rather than hidden) so its sub-bins don't end
    // up indented under nothing, and so "where it is now" stays visible. (A
    // mixed set of parents has no single no-op target, so none is greyed.)
    const parents = new Set<string | undefined>();
    for (const id of mediaIds) parents.add(proj!.media.find((m) => m.id === id)?.binId ?? undefined);
    for (const id of binIds) parents.add(bins.find((b) => b.id === id)?.parentId ?? undefined);
    const commonParent = parents.size === 1 ? [...parents][0] : undefined;
    // A bin can't be a target if it's a selected bin or inside one (cycle).
    const targets = orderedBinList.filter(({ bin: t }) => !binIds.some((bid) => isDescendant(bins, bid, t.id)));
    const anyNested = mediaIds.some((id) => proj!.media.find((m) => m.id === id)?.binId != null)
      || binIds.some((id) => bins.find((b) => b.id === id)?.parentId != null);
    const entries: ContextMenuEntry[] = [];
    if (anyNested) {
      entries.push({ label: "Top level", icon: <FolderOpen size={12} />, onClick: () => moveItemsToBin(mediaIds, binIds, null) });
      if (targets.length) entries.push({ separator: true });
    }
    entries.push(
      ...targets.map(({ bin: t, depth }) => t.id === commonParent
        ? { label: t.name, icon: <Folder size={12} />, indent: depth, disabled: true }
        : { label: t.name, icon: <Folder size={12} />, indent: depth, onClick: () => moveItemsToBin(mediaIds, binIds, t.id) }),
    );
    if (entries.length) entries.push({ separator: true });
    entries.push({
      label: "New bin…",
      icon: <FolderPlus size={12} />,
      onClick: () => {
        const id = createBinWithItems(mediaIds, binIds);
        if (id) editingBinId.value = id;
      },
    });
    return entries;
  };

  // Drop gone bins (removed or dissolved) from the bin selection — leftover ids
  // would just highlight nothing and leave a stale shift-anchor.
  const deselectBins = (ids: Iterable<string>) => {
    const drop = new Set(ids);
    const next = [...selectedBinIds.peek()].filter((id) => !drop.has(id));
    if (next.length !== selectedBinIds.peek().size) selectedBinIds.value = new Set(next);
  };

  // Dissolve bins, then clear them from the selection (their contents survive,
  // promoted up a level — but the bins themselves are gone).
  const dissolveSelectedBins = (binIds: string[]) => {
    dissolveBins(binIds);
    deselectBins(binIds);
  };

  // Remove a selection of clips and/or bins from the project (bins take their
  // whole sub-tree and the media inside). Files on disk are untouched. Confirms
  // only when media would be lost; an empty bin removes silently, like Dissolve.
  const removeSelection = async (mediaIds: string[], binIds: string[]) => {
    if (!proj) return;
    const subtreeBins = new Set<string>();
    for (const id of binIds) for (const x of collectSubtree(proj.bins ?? [], id)) subtreeBins.add(x);
    const removeMedia = new Set(mediaIds);
    // Media swept in via a selected bin's sub-tree, beyond what was directly
    // selected — this is the "surprise" the confirm guards against. Removing
    // only explicitly-picked clips (any number) is undoable and files-safe, so
    // it skips the prompt, matching how media removal has always worked.
    let implicit = 0;
    for (const mm of proj.media) {
      if (mm.binId != null && subtreeBins.has(mm.binId) && !removeMedia.has(mm.id)) {
        removeMedia.add(mm.id);
        implicit++;
      }
    }
    if (implicit > 0) {
      const choice = await confirmUnsavedChanges(
        `Remove ${countLabel(removeMedia.size, subtreeBins.size)} from the project? The original files on disk won't be deleted.`,
        { title: "Remove from project?", hideDiscard: true, confirmLabel: "Remove" },
      );
      if (choice !== "save") return;
    }
    removeMediaIds([...removeMedia], {
      removeBinIds: [...subtreeBins],
      label: "Remove from project",
      visibleOrderIds: visibleMedia.map((m) => m.id),
    });
    if (subtreeBins.size) {
      forgetBinCollapse(subtreeBins);
      deselectBins(subtreeBins);
    }
  };

  // Single, selection-aware context menu. Right-clicking a row outside the
  // selection resets to just it; right-clicking inside keeps the whole
  // selection. The contents adapt: a lone clip or lone bin get their full
  // single-item menu; a multi/mixed selection gets only the actions that make
  // sense across kinds (move, remove), so right-clicking a clip vs a bin in the
  // same mixed selection yields the same menu.
  const openContextMenuFor = (e: MouseEvent, clickedId: string, clickedKind: "media" | "bin") => {
    const inSelection = clickedKind === "media"
      ? selectedMediaIds.peek().has(clickedId)
      : selectedBinIds.peek().has(clickedId);
    if (!inSelection) {
      if (clickedKind === "media") {
        selectedMediaId.value = clickedId;
        selectedMediaIds.value = new Set([clickedId]);
        selectedBinIds.value = new Set();
      } else {
        selectedBinIds.value = new Set([clickedId]);
        selectedMediaIds.value = new Set();
      }
      selectionAnchor.value = clickedId;
    }
    const mediaIds = [...selectedMediaIds.peek()];
    const binIds = [...selectedBinIds.peek()];
    showContextMenu(e, buildSelectionMenu(mediaIds, binIds));
  };

  const buildSelectionMenu = (mediaIds: string[], binIds: string[]): ContextMenuEntry[] => {
    // Single clip: full clip menu, grouped — item actions · organize · destroy.
    if (mediaIds.length === 1 && binIds.length === 0) {
      const id = mediaIds[0];
      return [
        { label: "Settings…", onClick: () => { mediaSettingsId.value = id; } },
        { label: "Re-link file…", onClick: () => relinkMediaItem(id) },
        { separator: true },
        { label: "Move to…", submenu: buildMoveSubmenu(mediaIds, binIds) },
        { separator: true },
        { label: "Remove from project", danger: true, onClick: () => { void removeSelection(mediaIds, binIds); } },
      ];
    }
    // Single bin: full bin menu, grouped — create/rename · organize · destroy.
    if (binIds.length === 1 && mediaIds.length === 0) {
      const id = binIds[0];
      return [
        {
          label: "New sub-bin",
          icon: <FolderPlus size={12} />,
          onClick: () => { const nid = createBin(undefined, id); if (nid) { expandBin(id); editingBinId.value = nid; } },
        },
        { label: "Rename", onClick: () => { editingBinId.value = id; } },
        { separator: true },
        { label: "Move to…", submenu: buildMoveSubmenu(mediaIds, binIds) },
        { label: "Dissolve bin", onClick: () => dissolveSelectedBins([id]) },
        { separator: true },
        { label: "Delete bin", danger: true, onClick: () => { void removeSelection([], [id]); } },
      ];
    }
    // Multi / mixed: cross-kind actions. Dissolve only shows for a bins-only
    // selection — in a mixed one it would touch just the bins, which reads
    // oddly next to a "Move/Remove N items" that means everything.
    const label = countLabel(mediaIds.length, binIds.length);
    const items: ContextMenuEntry[] = [
      { label: `Move ${label} to…`, submenu: buildMoveSubmenu(mediaIds, binIds) },
    ];
    if (binIds.length > 1 && mediaIds.length === 0) {
      items.push({ label: `Dissolve ${binIds.length} bins`, onClick: () => dissolveSelectedBins(binIds) });
    }
    items.push(
      { separator: true },
      { label: `Remove ${label} from project`, danger: true, onClick: () => { void removeSelection(mediaIds, binIds); } },
    );
    return items;
  };

  const openRowMenu = (e: MouseEvent, item: MediaItem) => openContextMenuFor(e, item.id, "media");
  const openBinMenu = (e: MouseEvent, bin: Bin) => openContextMenuFor(e, bin.id, "bin");

  // ── Drag-and-drop (pointer-based) ───────────────────────────────────────
  // HTML5 drag events are disabled while Tauri's OS-file-drop is on, so rows are
  // dragged manually with pointer events + a hit-test. The move/cycle/selection
  // rules are unchanged — only the input mechanism is.

  // Can the current payload drop on `targetBinId` (null = top level)? Clips go
  // anywhere; a bin can't drop on itself or anything in its own subtree (cycle),
  // so the target must not be inside any dragged bin.
  const canDropOn = (targetBinId: string | null): boolean => {
    const p = dragPayload.peek();
    if (!p) return false;
    if (targetBinId === null) return true;
    // Read the live tree, not the render-time `bins` closure — a mid-drag
    // mutation (e.g. a batch finishing) could otherwise misjudge cycle safety.
    const liveBins = project.peek()?.bins ?? [];
    return !p.binIds.some((bid) => isDescendant(liveBins, bid, targetBinId));
  };

  // Begin a potential drag from a row. Nothing happens until the pointer moves
  // past a small threshold, so a plain click still selects. Dragging a row
  // outside the selection selects just it; dragging a selected row carries the
  // whole mixed selection. Only meaningful when bins exist (nowhere to move to
  // otherwise).
  const beginPointerDrag = (id: string, kind: "media" | "bin", e: PointerEvent) => {
    if (e.button !== 0 || !hasBins) return;
    // Captured only once a drag actually begins (see begin()), NOT on every
    // press — capturing redirects the follow-up click to this row, which would
    // swallow a plain click on the folder icon (its single-click toggle).
    const captureEl = e.currentTarget as HTMLElement | null;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let ghost: HTMLElement | null = null;
    let lastX = startX;
    let lastY = startY;
    let scrollRAF = 0;

    // Swallow the click that fires after a drag so it doesn't also select.
    const swallowClick = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      document.removeEventListener("click", swallowClick, true);
    };

    // Resolve the cursor position to a drop target: a bin (data-bin-id, innermost
    // wins), the top level (anywhere else in the panel body), or null (outside).
    const updateTarget = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const binEl = el?.closest("[data-bin-id]");
      if (binEl) {
        const t = binEl.getAttribute("data-bin-id");
        dropTarget.value = t && canDropOn(t) ? t : null;
      } else if (el && panelBodyRef.current?.contains(el)) {
        dropTarget.value = canDropOn(null) ? ROOT_DROP : null;
      } else {
        dropTarget.value = null;
      }
    };

    // Continuous auto-scroll while the pointer rests near the panel's edges.
    const autoScroll = () => {
      const body = panelBodyRef.current;
      if (!dragging || !body) return;
      const r = body.getBoundingClientRect();
      const margin = 28;
      const before = body.scrollTop;
      if (lastY < r.top + margin) body.scrollTop -= 10;
      else if (lastY > r.bottom - margin) body.scrollTop += 10;
      // Programmatic scrolling fires no pointermove, so when the list actually
      // moved, the row under the (possibly stationary) cursor changed — re-run
      // the hit-test so the drop target/highlight tracks the scrolled content
      // instead of staying pinned to the last pointermove position.
      if (body.scrollTop !== before) updateTarget(lastX, lastY);
      scrollRAF = requestAnimationFrame(autoScroll);
    };

    const begin = () => {
      dragging = true;
      hideTooltip(); // clear any hover tooltip already showing on the grabbed row
      // Capture now so move/up keep firing if the cursor leaves the window
      // mid-drag (a release outside would otherwise strand the ghost).
      captureEl?.setPointerCapture?.(e.pointerId);
      let mediaIds = [...selectedMediaIds.peek()];
      let binIds = [...selectedBinIds.peek()];
      const inSelection = kind === "media" ? mediaIds.includes(id) : binIds.includes(id);
      if (!inSelection) {
        // Grabbing an unselected row selects just it — plain, ignoring any held
        // Ctrl/Shift (else the highlight and the dragged payload would diverge).
        selectOnly(id, kind);
        mediaIds = kind === "media" ? [id] : [];
        binIds = kind === "bin" ? [id] : [];
      }
      dragPayload.value = { mediaIds, binIds };
      const count = mediaIds.length + binIds.length;
      const name = kind === "media"
        ? proj?.media.find((m) => m.id === id)?.name
        : bins.find((b) => b.id === id)?.name;
      ghost = createDragGhost(count > 1 ? `${count} items` : (name ?? "1 item"));
      document.body.classList.add("rows-dragging");
      document.addEventListener("click", swallowClick, true);
      scrollRAF = requestAnimationFrame(autoScroll);
    };

    const onMove = (ev: PointerEvent) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return;
        begin();
      }
      if (ghost) {
        ghost.style.left = `${ev.clientX + 12}px`;
        ghost.style.top = `${ev.clientY + 12}px`;
      }
      updateTarget(ev.clientX, ev.clientY);
    };

    const finish = (drop: boolean) => {
      const wasDragging = dragging;
      dragging = false;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("keydown", onKey);
      if (captureEl?.hasPointerCapture?.(e.pointerId)) captureEl.releasePointerCapture(e.pointerId);
      cancelAnimationFrame(scrollRAF);
      ghost?.remove();
      document.body.classList.remove("rows-dragging");
      const p = dragPayload.peek();
      const target = dropTarget.peek();
      dragPayload.value = null;
      dropTarget.value = null;
      if (drop && wasDragging && p && target !== null) {
        moveItemsToBin(p.mediaIds, p.binIds, target === ROOT_DROP ? null : target);
      }
      // If a click follows (drag started on this row), swallowClick eats it;
      // otherwise tidy the listener up next tick.
      if (wasDragging) setTimeout(() => document.removeEventListener("click", swallowClick, true), 0);
      dragCleanupRef.current = null;
    };

    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      // While dragging, Escape cancels the drag and nothing else — don't let it
      // also reach other app Escape handlers (e.g. the caption editor).
      if (dragging) { ev.preventDefault(); ev.stopPropagation(); }
      finish(false);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("keydown", onKey);
    // Let an unmount mid-drag tear everything down (no terminal pointer event
    // would otherwise fire) — mirrors PanelResizeHandle's safety net.
    dragCleanupRef.current = () => finish(false);
  };

  // depth = nesting level of the row (0 = top-level / ungrouped). Media inside a
  // bin at level L render at depth L+1; the indent is computed from it.
  const renderRow = (item: MediaItem, depth: number) => (
    <MediaRow
      key={item.id}
      item={item}
      query={query}
      depth={depth}
      onSelect={(e) => selectRow(item, e)}
      onContextMenu={(e) => openRowMenu(e, item)}
      onPointerDownDrag={(e) => beginPointerDrag(item.id, "media", e)}
    />
  );

  // Render a bin node and (when expanded) its sub-bins then its media, recursing
  // to any depth. depth drives indentation; the rest mirrors the flat version.
  const renderNode = (node: BinNode, depth: number) => (
    <BinGroup
      key={node.bin.id}
      bin={node.bin}
      count={binCounts.get(node.bin.id) ?? 0}
      depth={depth}
      collapsed={isCollapsed(node.bin.id)}
      // While searching, hide branches with no matches anywhere inside.
      hidden={searching && !binShown(node)}
      editing={editingBinId.value === node.bin.id}
      query={query}
      onSelect={(e) => selectRowId(node.bin.id, "bin", e)}
      // Inert while searching: bins are force-expanded, so toggling would only
      // (invisibly) mutate the persisted collapse state and surprise the user
      // once the search clears.
      onToggle={() => { if (!searching) toggleBinCollapsed(node.bin.id); }}
      onContextMenu={(e) => openBinMenu(e, node.bin)}
      onRename={(name) => { renameBin(node.bin.id, name); editingBinId.value = null; }}
      onCancelRename={() => { editingBinId.value = null; }}
      onPointerDownDrag={(e) => { if (editingBinId.value !== node.bin.id) beginPointerDrag(node.bin.id, "bin", e); }}
      renderItems={() => (
        <>
          {node.children.map((c) => renderNode(c, depth + 1))}
          {node.items.map((m) => renderRow(m, depth + 1))}
        </>
      )}
    />
  );

  return (
    <div class="panel project-panel">
      {/* Search expands inline in the header, replacing only the title — the
          action buttons stay put, so opening search neither pushes the list
          down, covers any rows, nor hides sort/import. */}
      <div class="panel-header">
        {showSearch ? (
          <div class="panel-header-search">
            <span class="panel-filter-icon"><MagnifyingGlass size={13} /></span>
            <input
              ref={searchInputRef}
              class="panel-filter-input"
              type="text"
              placeholder="Search project…"
              value={filterText.value}
              onInput={(e) => { filterText.value = (e.target as HTMLInputElement).value; }}
              onKeyDown={(e) => { if (e.key === "Escape") closeSearch(); }}
              onBlur={() => { if (!filterText.value) closeSearch(); }}
            />
            {filterText.value && (
              <button
                class="panel-filter-clear"
                data-tooltip="Clear search"
                onClick={() => { filterText.value = ""; searchInputRef.current?.focus(); }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        ) : (
          <span class="panel-header-title">Project</span>
        )}
        {proj && (
          <div class="panel-header-actions">
            {hasMedia && !showSearch && (
              <button
                class="btn btn-ghost btn-icon"
                data-tooltip="Search project"
                onClick={() => { openSearch(); searchInputRef.current?.focus(); }}
              >
                <MagnifyingGlass size={14} />
              </button>
            )}
            {hasMedia && (
              <button
                class="btn btn-ghost btn-icon"
                // With exactly one bin highlighted, make the new bin a sub-bin
                // of it; otherwise (none, or an ambiguous multi-selection) a
                // top-level bin. Stays available while searching — but creating
                // a bin exits search first, so the new (empty) bin isn't hidden
                // by the active filter and can be named right away.
                data-tooltip={newBinTooltip}
                onClick={() => {
                  closeSearch();
                  const sel = [...selectedBinIds.peek()];
                  const parentId = sel.length === 1 ? sel[0] : undefined;
                  const id = createBin(undefined, parentId);
                  if (id) {
                    if (parentId) expandBin(parentId);
                    editingBinId.value = id;
                  }
                }}
              >
                <FolderPlus size={14} />
              </button>
            )}
            <SortMenu />
            <button
              class="btn btn-ghost btn-icon"
              data-tooltip="Import media"
              onClick={importMedia}
            >
              <Plus size={14} />
            </button>
          </div>
        )}
        <PanelResizeHandle />
      </div>

      {/* The whole scrollable body is the top-level drop zone: a pointer drag
          that ends here (outside any bin) drops to the root. The drag hit-test
          finds bins by their data-bin-id and falls back to this element. */}
      <div
        ref={panelBodyRef}
        class={panelBodyClass}
        // A click that misses every row (empty space, the list padding) clears
        // the selection and closes the editor — row clicks select and stop here
        // by hitting .media-row first. (A drag's trailing click is swallowed, so
        // dragging onto empty space won't deselect.)
        // Also clear the shift-range anchor (a ProjectPanel-local signal
        // deselectAll can't reach), so a later shift-click starts fresh instead
        // of resurrecting the just-discarded range from the stale anchor.
        onClick={(e) => { if (!(e.target as HTMLElement).closest(".media-row")) { selectionAnchor.value = null; deselectAll(); } }}
      >
        {!proj ? (
          <div class="empty-state">
            <span class="empty-state-title">No project open</span>
            <span class="empty-state-body">Create or open a project to get started.</span>
            <div class="project-panel-actions">
              <button class="btn btn-primary btn-sm" onClick={newProjectGuarded}><FilePlus size={13} /> New Project</button>
              <button class="btn btn-secondary btn-sm" onClick={openProjectGuarded}><FolderOpen size={13} /> Open…</button>
            </div>
            {recentProjects.value.length > 0 && (
              <div class="project-panel-recent">
                <span class="project-panel-recent-title">Recent</span>
                {recentProjects.value.slice(0, 5).map((r) => (
                  <button
                    key={r.path}
                    class="project-panel-recent-item"
                    data-tooltip={r.path}
                    onClick={() => {
                      hideTooltip();
                      openRecent(r.path);
                    }}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : proj.media.length === 0 ? (
          <div class="empty-state">
            <span class="empty-state-title">No media</span>
            <span class="empty-state-body">Import a video or audio file to begin.</span>
          </div>
        ) : searching && visibleMedia.length === 0 && revealedBins.size === 0 ? (
          <div class="empty-state">
            <span class="empty-state-title">No items found</span>
            <span class="empty-state-body">Nothing matches “{filterText.value.trim()}”.</span>
          </div>
        ) : !hasBins ? (
          // No bins → flat list, exactly as before.
          <div class="media-list">{visibleMedia.map((m) => renderRow(m, 0))}</div>
        ) : (
          // Bins render as media-style rows (folder icon + media count); their
          // sub-bins and members render indented beneath when expanded, to any
          // depth. Ungrouped media are plain top-level rows after the bins —
          // no separate section header. The top-level drop zone is the whole
          // panel body (above); dropping outside any bin pulls a clip/bin out
          // to the root.
          <div class="media-list">
            {forest.roots.map((node) => renderNode(node, 0))}
            {forest.ungrouped.map((m) => renderRow(m, 0))}
          </div>
        )}
      </div>
    </div>
  );
}

function BinGroup({ bin, count, depth, collapsed, hidden, editing, query, onSelect, onToggle, onContextMenu, onRename, onCancelRename, onPointerDownDrag, renderItems }: {
  bin: Bin;
  count: number;
  depth: number;
  collapsed: boolean;
  hidden: boolean;
  editing: boolean;
  query: string;
  onSelect: (e: MouseEvent) => void;
  onToggle: () => void;
  onContextMenu: (e: MouseEvent) => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onPointerDownDrag: (e: PointerEvent) => void;
  renderItems: () => ComponentChildren;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards a single commit: Enter/Escape and the blur that follows unmounting
  // the focused input must not both fire onRename. Reset each time editing opens.
  const committed = useRef(false);
  useEffect(() => {
    if (editing) {
      committed.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // Bound to class so selecting the bin or dragging over it updates only this
  // element's attribute — no BinGroup re-render. Reads the signals directly
  // (not props), so the parent never subscribes to selection/dropTarget.
  const rowClass = useComputed(
    () =>
      `media-row media-row--bin${selectedBinIds.value.has(bin.id) ? " media-row--selected" : ""}` +
      `${dropTarget.value === bin.id ? " media-row--drop-target" : ""}` +
      `${openIndicatorId.value === bin.id ? " media-row--open" : ""}`,
  );

  if (hidden) return null;

  const searching = query.length > 0;

  const commit = (value: string) => {
    if (committed.current) return;
    committed.current = true;
    onRename(value);
  };
  const cancel = () => {
    if (committed.current) return;
    committed.current = true;
    onCancelRename();
  };

  const meta = count === 0 ? "Empty" : `${count} item${count === 1 ? "" : "s"}`;

  return (
    // The whole bin block (header + contents) is this bin's drop zone — the drag
    // hit-test matches data-bin-id, and nested bins carry their own so the
    // innermost one under the cursor wins.
    <div data-bin-id={bin.id}>
      {/* Styled like a media row; the open/closed folder icon both marks it as
          a bin and is its expand/collapse control (no separate caret, so a bin
          row has the same [icon][name] layout as a clip and the two align).
          Clicking the row selects it like a clip; the folder icon or a
          double-click toggles open/closed. Each nesting level shifts the row
          right by one indent step. The row is the drag handle and shows both
          the selected and drop-target highlights. */}
      <div
        class={rowClass}
        style={depth > 0 ? { paddingLeft: `calc(var(--space-3) + min(${depth * BIN_INDENT_STEP}px, 45%))` } : undefined}
        onPointerDown={onPointerDownDrag}
        onClick={(e) => { if (!editing) onSelect(e); }}
        onDblClick={() => { if (!editing) onToggle(); }}
        onContextMenu={onContextMenu}
      >
        <span
          // While searching the disclosure is forced open and toggling is
          // inert, so the icon drops its toggle affordance and a click just
          // falls through to select the row (like a clip's icon).
          class={`media-row-icon${searching ? "" : " bin-row-toggle"}`}
          data-tooltip={searching ? undefined : collapsed ? "Expand" : "Collapse"}
          onClick={(e) => { if (!editing && !searching) { e.stopPropagation(); onToggle(); } }}
        >
          {collapsed ? <Folder size={14} /> : <FolderOpen size={14} />}
        </span>
        <span class="media-row-info">
          {editing ? (
            // Uncontrolled (defaultValue): a controlled value would be reset to
            // bin.name on any unrelated signal re-render mid-edit.
            <input
              ref={inputRef}
              class="bin-row-input"
              type="text"
              defaultValue={bin.name}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
                else if (e.key === "Escape") cancel();
              }}
              onBlur={(e) => commit((e.target as HTMLInputElement).value)}
            />
          ) : (
            <>
              <span class="media-row-name">{highlightMatch(bin.name, query)}</span>
              <span class="media-row-meta">{meta}</span>
            </>
          )}
        </span>
      </div>
      {!collapsed && renderItems()}
    </div>
  );
}

function MediaRow({ item, query, depth, onSelect, onContextMenu, onPointerDownDrag }: {
  item: MediaItem;
  query: string;
  depth: number;
  onSelect: (e: MouseEvent) => void;
  onContextMenu: (e: MouseEvent) => void;
  onPointerDownDrag: (e: PointerEvent) => void;
}) {
  // `missing` drives the badge/meta child (a render-time swap), so the row does
  // re-render when its missing state flips (rare — only on a media-existence
  // re-check). Selection, by contrast, is bound to class below and never
  // re-renders the row.
  const missing = missingIds.value.has(item.id);
  const rowClass = useComputed(
    () =>
      `media-row${selectedMediaIds.value.has(item.id) ? " media-row--selected" : ""}` +
      `${missingIds.value.has(item.id) ? " media-row--missing" : ""}` +
      `${openIndicatorId.value === item.id ? " media-row--open" : ""}`,
  );

  const captionMeta = item.captions.length > 0
    ? `${item.captions.length} captions`
    : "No captions";

  const fpsLabel = item.fps != null
    ? `${item.fps} fps${item.dropFrame != null ? (item.dropFrame ? " DF" : " NDF") : ""}`
    : null;

  // Same indent formula and [icon][name] layout as bin rows, so a clip and a
  // sub-bin at the same depth line up exactly. Clamped (min with 45%) so a very
  // deep tree never squeezes the name on a narrow panel.
  const style = depth > 0
    ? { paddingLeft: `calc(var(--space-3) + min(${depth * BIN_INDENT_STEP}px, 45%))` }
    : undefined;

  return (
    <button
      class={rowClass}
      style={style}
      data-tooltip={`${item.name}\n${item.path}${fpsLabel ? `\n${fpsLabel}` : ""}`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDownDrag}
    >
      <span class="media-row-icon">{getMediaIcon(item.path)}</span>
      <span class="media-row-info">
        <span class="media-row-name">{highlightMatch(item.name, query)}</span>
        {missing ? (
          <span class="media-row-missing-badge"><WarningCircle size={11} /> Missing</span>
        ) : (
          <span class="media-row-meta">{captionMeta}</span>
        )}
      </span>
    </button>
  );
}

/** Wrap the first occurrence of `query` (already lowercased) in a <mark> so
 *  the filter match stands out. Matches the same way the filter decides
 *  visibility — lowercase + substring — so highlight and visibility never
 *  disagree. Offsets from the lowercased string only map onto the original
 *  when lowercasing is length-preserving; for the rare char where it isn't
 *  (e.g. U+0130 İ) we skip the <mark> rather than mis-slice, so the row still
 *  shows, just un-highlighted. Returns the plain name when there's no hit. */
function highlightMatch(name: string, query: string): ComponentChildren {
  if (!query) return name;
  const lower = name.toLowerCase();
  if (lower.length !== name.length) return name;
  const idx = lower.indexOf(query);
  if (idx < 0) return name;
  const end = idx + query.length;
  return (
    <>
      {name.slice(0, idx)}
      <mark class="media-row-match">{name.slice(idx, end)}</mark>
      {name.slice(end)}
    </>
  );
}

function getMediaIcon(path: string) {
  const ext = path.replace(/\\/g, "/").split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTS.includes(ext)
    ? <FilmSlate size={14} />
    : <MusicNote size={14} />;
}
