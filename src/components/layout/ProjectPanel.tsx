import { useEffect, useRef, useState, useMemo } from "preact/hooks";
import { FilmSlateIcon as FilmSlate, MusicNoteIcon as MusicNote, WarningCircleIcon as WarningCircle, PlusIcon as Plus, FilePlusIcon as FilePlus, FolderOpenIcon as FolderOpen, FolderIcon as Folder, FolderPlusIcon as FolderPlus, ArrowsDownUpIcon as ArrowsDownUp, CheckIcon as Check, MagnifyingGlassIcon as MagnifyingGlass, XIcon as X } from "@phosphor-icons/react";
import type { ComponentChildren } from "preact";
import { signal } from "@preact/signals";
import { project, selectedMediaId, selectedMediaIds, selectedCaptionIndex, pushHistory } from "../../store/app";
import {
  newProjectGuarded,
  openProjectGuarded,
  openRecent,
  importMedia,
  relinkMediaItem,
  fileExists,
  VIDEO_EXTS,
} from "../../lib/project";
import {
  buildBinForest,
  sortBins,
  collectSubtree,
  isDescendant,
  rangeSelect,
  collapsedBins,
  toggleBinCollapsed,
  expandBin,
  createBin,
  createBinWithMedia,
  renameBin,
  dissolveBin,
  moveBin,
  moveMediaToBin,
  forgetBinCollapse,
  type BinNode,
} from "../../lib/bins";
import { recentProjects } from "../../lib/recent";
import { showContextMenu, type ContextMenuItem } from "../ContextMenu";
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
type DragPayload = { kind: "media"; ids: string[] } | { kind: "bin"; id: string };
const dragPayload = signal<DragPayload | null>(null);
// dropTarget holds the hovered bin's id, ROOT_DROP for the top-level area, or
// null for "no valid target under the cursor".
const ROOT_DROP = "__root__";
const dropTarget = signal<string | null>(null);

// Replace the browser's default drag image (a faint snapshot of just the row
// you grabbed) with a small label pill — so a multi-clip drag reads as "N
// clips" rather than a single row. The element must be in the DOM and rendered
// when setDragImage runs, so it's parked offscreen and removed on the next tick
// (after the browser has snapshotted it).
function setDragImageLabel(e: DragEvent, label: string) {
  if (!e.dataTransfer) return;
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  ghost.textContent = label;
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 12, 12);
  setTimeout(() => ghost.remove(), 0);
}

// Indent a bin's name by its tree depth for the flat "Move to bin" pickers.
// Non-breaking spaces so the leading indent isn't collapsed in the button text.
const indentLabel = (depth: number, name: string) => `${"  ".repeat(depth)}${name}`;

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

function removeMediaIds(mediaIds: string[], opts?: { removeBinIds?: string[]; label?: string }) {
  const proj = project.value;
  const removeBinIds = opts?.removeBinIds;
  if (!proj || (mediaIds.length === 0 && !removeBinIds?.length)) return;
  const removing = new Set(mediaIds);
  const active = selectedMediaId.value;
  const removingActive = active !== null && removing.has(active);
  // When removing the active item, move selection to the nearest surviving
  // neighbour in *visible* (sorted/filtered) order — under a non-default sort
  // or active filter the media array order diverges from what the user sees.
  let nextId = active;
  if (removingActive) {
    const visibleBefore = visibleOrder(proj.media);
    const pos = visibleBefore.findIndex((m) => removing.has(m.id));
    const after = visibleBefore.slice(pos + 1).find((m) => !removing.has(m.id));
    const before = [...visibleBefore.slice(0, pos)].reverse().find((m) => !removing.has(m.id));
    nextId = after?.id ?? before?.id ?? null;
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

  useEffect(() => {
    checkMissingMedia(proj?.media ?? []);
  }, [proj?.media]);

  // Focus the search field when it opens.
  useEffect(() => {
    if (searchOpen.value) searchInputRef.current?.focus();
  }, [searchOpen.value]);

  // Clear any leftover filter when a different project is opened — a stale
  // query that hides everything in the new project would be confusing. Keyed
  // on createdAt (stable within a project, differs across them), guarded by a
  // module-level marker so it fires only on a genuine project change — not on
  // every remount (e.g. a daemon-crash splash), which would wipe an in-progress
  // filter even though the project never changed. Done inline during render
  // (before `query` is read) rather than in an effect, so the new project
  // never renders one frame filtered by the old query.
  const projectKey = proj?.createdAt ?? null;
  if (projectKey !== lastFilterResetKey) {
    lastFilterResetKey = projectKey;
    searchOpen.value = false;
    filterText.value = "";
  }

  // Closed search never filters, even if filterText somehow lingers.
  const query = searchOpen.value ? filterText.value.trim().toLowerCase() : "";
  const hasMedia = (proj?.media.length ?? 0) > 0;
  const media = proj?.media;
  const sMode = sortMode.value;
  const sDir = sortDir.value;
  const visibleMedia = useMemo(
    () => (media ? visibleOrder(media) : []),
    [media, sMode, sDir, query],
  );

  const showSearch = !!proj && hasMedia && searchOpen.value;

  const bins = proj?.bins ?? [];
  const hasBins = bins.length > 0;
  const selIds = selectedMediaIds.value;
  const searching = query.length > 0;
  // Sub-bins at each level follow the same sort as media; media keep the
  // already-sorted order they arrive in. Bins first, then ungrouped media.
  const forest = buildBinForest(visibleMedia, bins, (level) => sortBins(level, sMode, sDir));
  const collapsedSet = collapsedBins.value;
  const isCollapsed = (binId: string) => !searching && collapsedSet.has(binId);

  // True when the bin or anything nested under it holds a (filtered-in) media
  // item — used while searching to hide whole branches that match nothing.
  const subtreeHasItems = (node: BinNode): boolean =>
    node.items.length > 0 || node.children.some(subtreeHasItems);

  // Total membership per bin (from the full media list, not the filtered view)
  // — the badge and the bin's Generate/Export both mean "all members".
  const binCounts = new Map<string, number>();
  for (const mm of proj?.media ?? []) {
    if (mm.binId != null) binCounts.set(mm.binId, (binCounts.get(mm.binId) ?? 0) + 1);
  }

  // Ids of the rows actually on screen, in display order, so a shift-range
  // can't silently pull in items hidden inside a collapsed (or search-hidden)
  // bin. Mirrors the render: per node, sub-bins then this bin's media.
  const orderedIds: string[] = [];
  const collectVisible = (nodes: BinNode[]) => {
    for (const node of nodes) {
      if (searching && !subtreeHasItems(node)) continue;
      if (isCollapsed(node.bin.id)) continue;
      collectVisible(node.children);
      for (const m of node.items) orderedIds.push(m.id);
    }
  };
  collectVisible(forest.roots);
  for (const m of forest.ungrouped) orderedIds.push(m.id);

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

  // Plain click selects one; Ctrl/Cmd toggles; Shift extends a range over the
  // visible (flattened) order from the last anchor. selectedMediaId stays the
  // active item the editor follows; selectedMediaIds is the bulk-action set.
  const selectRow = (item: MediaItem, e: MouseEvent) => {
    const current = selectedMediaIds.peek();
    if (e.shiftKey && selectionAnchor.value) {
      selectedMediaIds.value = new Set(rangeSelect(orderedIds, selectionAnchor.value, item.id));
      selectedMediaId.value = item.id;
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      selectedMediaIds.value = next;
      selectedMediaId.value = next.has(item.id) ? item.id : (orderedIds.find((id) => next.has(id)) ?? null);
      selectionAnchor.value = item.id;
    } else {
      selectedMediaId.value = item.id;
      selectedMediaIds.value = new Set([item.id]);
      selectionAnchor.value = item.id;
    }
  };

  const openRowMenu = (e: MouseEvent, item: MediaItem) => {
    // Right-clicking a row outside the current selection acts on just that row.
    if (!selectedMediaIds.peek().has(item.id)) {
      selectedMediaId.value = item.id;
      selectedMediaIds.value = new Set([item.id]);
      selectionAnchor.value = item.id;
    }
    const ids = [...selectedMediaIds.peek()];
    const multi = ids.length > 1;
    const moveSubmenu: ContextMenuItem[] = [
      ...orderedBinList.map(({ bin: b, depth }) => ({
        label: indentLabel(depth, b.name),
        onClick: () => moveMediaToBin(ids, b.id),
      })),
      {
        label: "New bin…",
        onClick: () => {
          // One undo step (create + move together), auto-named without collision.
          const id = createBinWithMedia(ids);
          if (id) editingBinId.value = id;
        },
      },
    ];
    const anyBinned = ids.some((id) => proj!.media.find((m) => m.id === id)?.binId != null);
    const items: ContextMenuItem[] = [];
    if (!multi) {
      items.push({ label: "Settings…", onClick: () => { mediaSettingsId.value = item.id; } });
      items.push({ label: "Re-link file…", onClick: () => relinkMediaItem(item.id) });
    }
    items.push({ label: multi ? `Move ${ids.length} to bin` : "Move to bin", submenu: moveSubmenu });
    if (anyBinned) items.push({ label: "Remove from bin", onClick: () => moveMediaToBin(ids, null) });
    items.push({
      label: multi ? `Remove ${ids.length} from project` : "Remove from project",
      danger: true,
      onClick: () => removeMediaIds(ids),
    });
    showContextMenu(e, items);
  };

  // Delete a bin, its entire sub-tree, AND all media anywhere within it from the
  // project (files on disk are untouched). Confirm only when there's media to
  // lose; an empty branch deletes like Dissolve.
  const deleteBin = async (bin: Bin) => {
    if (!proj) return;
    const subtree = collectSubtree(proj.bins ?? [], bin.id);
    const memberIds = proj.media.filter((m) => m.binId != null && subtree.has(m.binId)).map((m) => m.id);
    if (memberIds.length > 0) {
      const choice = await confirmUnsavedChanges(
        `Delete “${bin.name}” and its ${memberIds.length} media item${memberIds.length === 1 ? "" : "s"} from the project? The original files on disk won't be deleted.`,
        { title: "Delete bin?", hideDiscard: true, confirmLabel: "Delete" },
      );
      if (choice !== "save") return;
    }
    removeMediaIds(memberIds, { removeBinIds: [...subtree], label: "Delete bin" });
    forgetBinCollapse(subtree);
  };

  const openBinMenu = (e: MouseEvent, bin: Bin) => {
    // "Move to" can target any bin that isn't this one or nested inside it
    // (that would make a cycle), plus the top level when it's currently nested.
    const moveTargets = orderedBinList.filter(({ bin: t }) => !isDescendant(bins, bin.id, t.id));
    const moveSubmenu: ContextMenuItem[] = [];
    if (bin.parentId != null) {
      moveSubmenu.push({ label: "Top level", onClick: () => moveBin(bin.id, null) });
    }
    moveSubmenu.push(
      ...moveTargets.map(({ bin: t, depth }) => ({
        label: indentLabel(depth, t.name),
        onClick: () => moveBin(bin.id, t.id),
      })),
    );
    const items: ContextMenuItem[] = [
      {
        label: "New sub-bin",
        onClick: () => {
          const id = createBin(undefined, bin.id);
          if (id) { expandBin(bin.id); editingBinId.value = id; }
        },
      },
      { label: "Rename", onClick: () => { editingBinId.value = bin.id; } },
    ];
    if (moveSubmenu.length) items.push({ label: "Move to…", submenu: moveSubmenu });
    items.push(
      { label: "Dissolve bin", onClick: () => dissolveBin(bin.id) },
      { label: "Delete bin", danger: true, onClick: () => { void deleteBin(bin); } },
    );
    showContextMenu(e, items);
  };

  // ── Drag-and-drop ──────────────────────────────────────────────────────
  // Start dragging a clip. Dragging a row outside the current selection acts on
  // just that row (and selects it); dragging a selected row carries the whole
  // selection — so you can box-select and move a batch at once.
  const startMediaDrag = (item: MediaItem, e: DragEvent) => {
    let ids = [...selectedMediaIds.peek()];
    if (!ids.includes(item.id)) {
      selectedMediaId.value = item.id;
      selectedMediaIds.value = new Set([item.id]);
      selectionAnchor.value = item.id;
      ids = [item.id];
    }
    dragPayload.value = { kind: "media", ids };
    e.dataTransfer?.setData("text/plain", "");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    setDragImageLabel(e, ids.length > 1 ? `${ids.length} clips` : item.name);
  };

  const startBinDrag = (bin: Bin, e: DragEvent) => {
    dragPayload.value = { kind: "bin", id: bin.id };
    e.dataTransfer?.setData("text/plain", "");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    setDragImageLabel(e, bin.name);
  };

  const endDrag = () => { dragPayload.value = null; dropTarget.value = null; };

  // Can the current payload drop on `targetBinId` (null = top level)? Media go
  // anywhere; a bin can't drop on itself or anything in its own subtree (cycle).
  const canDropOn = (targetBinId: string | null): boolean => {
    const p = dragPayload.peek();
    if (!p) return false;
    if (p.kind === "media") return true;
    return targetBinId === null || !isDescendant(bins, p.id, targetBinId);
  };

  // dragover decides the drop: preventDefault enables a drop here, and the
  // event stops at the innermost bin so it doesn't also light up the root zone.
  // An invalid target still stops propagation (so root doesn't catch it) but
  // doesn't preventDefault, so no drop can land and the cursor shows no-drop.
  const onTargetDragOver = (targetBinId: string | null, e: DragEvent) => {
    if (targetBinId !== null) e.stopPropagation();
    if (!canDropOn(targetBinId)) { if (targetBinId !== null) dropTarget.value = null; return; }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dropTarget.value = targetBinId ?? ROOT_DROP;
  };

  const onTargetDrop = (targetBinId: string | null, e: DragEvent) => {
    e.preventDefault();
    if (targetBinId !== null) e.stopPropagation();
    const p = dragPayload.peek();
    endDrag();
    if (!p) return;
    if (p.kind === "media") moveMediaToBin(p.ids, targetBinId);
    // Re-check with the captured payload (endDrag cleared the signal): a bin
    // can't land on itself or its own subtree.
    else if (targetBinId === null || !isDescendant(bins, p.id, targetBinId)) moveBin(p.id, targetBinId);
  };

  // depth = nesting level of the row (0 = top-level / ungrouped). Media inside a
  // bin at level L render at depth L+1; the indent is computed from it.
  const renderRow = (item: MediaItem, depth: number) => (
    <MediaRow
      key={item.id}
      item={item}
      query={query}
      selected={selIds.has(item.id)}
      missing={missingIds.value.has(item.id)}
      depth={depth}
      onSelect={(e) => selectRow(item, e)}
      onContextMenu={(e) => openRowMenu(e, item)}
      onDragStart={(e) => startMediaDrag(item, e)}
      onDragEnd={endDrag}
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
      hidden={searching && !subtreeHasItems(node)}
      editing={editingBinId.value === node.bin.id}
      dropActive={dropTarget.value === node.bin.id}
      onToggle={() => toggleBinCollapsed(node.bin.id)}
      onContextMenu={(e) => openBinMenu(e, node.bin)}
      onRename={(name) => { renameBin(node.bin.id, name); editingBinId.value = null; }}
      onCancelRename={() => { editingBinId.value = null; }}
      onDragStartBin={(e) => startBinDrag(node.bin, e)}
      onDragEnd={endDrag}
      onDragOver={(e) => onTargetDragOver(node.bin.id, e)}
      onDrop={(e) => onTargetDrop(node.bin.id, e)}
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
              placeholder="Search media…"
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
                data-tooltip="Search media"
                onClick={() => { openSearch(); searchInputRef.current?.focus(); }}
              >
                <MagnifyingGlass size={14} />
              </button>
            )}
            {hasMedia && !showSearch && (
              <button
                class="btn btn-ghost btn-icon"
                data-tooltip="New bin"
                onClick={() => { const id = createBin(); if (id) editingBinId.value = id; }}
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

      <div class="panel-body scrollable">
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
        ) : visibleMedia.length === 0 ? (
          <div class="empty-state">
            <span class="empty-state-title">No matches</span>
            <span class="empty-state-body">No media matches “{filterText.value.trim()}”.</span>
          </div>
        ) : !hasBins ? (
          // No bins → flat list, exactly as before.
          <div class="media-list">{visibleMedia.map((m) => renderRow(m, 0))}</div>
        ) : (
          // Bins render as media-style rows (folder icon + media count); their
          // sub-bins and members render indented beneath when expanded, to any
          // depth. Ungrouped media are plain top-level rows after the bins —
          // no separate section header. The list itself is the top-level drop
          // zone: dropping here pulls a clip/bin out to the root. Inner bins
          // stopPropagation on dragover/drop so they win over this.
          <div
            class={`media-list${dropTarget.value === ROOT_DROP ? " media-list--drop-root" : ""}`}
            onDragOver={(e) => onTargetDragOver(null, e)}
            onDrop={(e) => onTargetDrop(null, e)}
          >
            {forest.roots.map((node) => renderNode(node, 0))}
            {forest.ungrouped.map((m) => renderRow(m, 0))}
          </div>
        )}
      </div>
    </div>
  );
}

function BinGroup({ bin, count, depth, collapsed, hidden, editing, dropActive, onToggle, onContextMenu, onRename, onCancelRename, onDragStartBin, onDragEnd, onDragOver, onDrop, renderItems }: {
  bin: Bin;
  count: number;
  depth: number;
  collapsed: boolean;
  hidden: boolean;
  editing: boolean;
  dropActive: boolean;
  onToggle: () => void;
  onContextMenu: (e: MouseEvent) => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onDragStartBin: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
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

  if (hidden) return null;

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
    // The whole bin block (header + contents) is the drop zone for this bin;
    // nested bins inside it stopPropagation so the innermost one wins.
    <div onDragOver={onDragOver} onDrop={onDrop}>
      {/* Styled like a media row; the open/closed folder icon both marks it as
          a bin and shows its expanded state (no separate caret, so a bin row
          has the same [icon][name] layout as a clip and the two align). Each
          nesting level shifts the row right by one indent step. The row itself
          is the drag handle and shows the drop highlight. */}
      <div
        class={`media-row media-row--bin${dropActive ? " media-row--drop-target" : ""}`}
        style={depth > 0 ? { paddingLeft: `calc(var(--space-3) + ${depth * BIN_INDENT_STEP}px)` } : undefined}
        draggable={!editing}
        onDragStart={onDragStartBin}
        onDragEnd={onDragEnd}
        onClick={() => { if (!editing) onToggle(); }}
        onContextMenu={onContextMenu}
      >
        <span class="media-row-icon">
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
              <span class="media-row-name">{bin.name}</span>
              <span class="media-row-meta">{meta}</span>
            </>
          )}
        </span>
      </div>
      {!collapsed && renderItems()}
    </div>
  );
}

function MediaRow({ item, query, selected, missing, depth, onSelect, onContextMenu, onDragStart, onDragEnd }: {
  item: MediaItem;
  query: string;
  selected: boolean;
  missing: boolean;
  depth: number;
  onSelect: (e: MouseEvent) => void;
  onContextMenu: (e: MouseEvent) => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const meta = missing
    ? "File not found"
    : item.captions.length > 0
      ? `${item.captions.length} captions`
      : "No captions";

  const fpsLabel = item.fps != null
    ? `${item.fps} fps${item.dropFrame != null ? (item.dropFrame ? " DF" : " NDF") : ""}`
    : null;

  // Same indent formula and [icon][name] layout as bin rows, so a clip and a
  // sub-bin at the same depth line up exactly.
  const style = depth > 0
    ? { paddingLeft: `calc(var(--space-3) + ${depth * BIN_INDENT_STEP}px)` }
    : undefined;

  return (
    <button
      class={`media-row ${selected ? "media-row--selected" : ""} ${missing ? "media-row--missing" : ""}`}
      style={style}
      draggable
      data-tooltip={`${item.name}\n${item.path}`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <span class="media-row-icon">{getMediaIcon(item.path)}</span>
      <span class="media-row-info">
        <span class="media-row-name">{highlightMatch(item.name, query)}</span>
        <span class={`media-row-meta ${missing ? "media-row-meta--warning" : ""}`}>
          {missing && <WarningCircle size={11} />}{meta}
          {fpsLabel && !missing && (
            <span class="media-row-fps">{fpsLabel}</span>
          )}
        </span>
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
