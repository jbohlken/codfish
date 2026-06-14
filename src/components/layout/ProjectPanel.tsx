import { useEffect, useRef, useState, useMemo } from "preact/hooks";
import { FilmSlateIcon as FilmSlate, MusicNoteIcon as MusicNote, WarningCircleIcon as WarningCircle, PlusIcon as Plus, FilePlusIcon as FilePlus, FolderOpenIcon as FolderOpen, ArrowsDownUpIcon as ArrowsDownUp, CheckIcon as Check, MagnifyingGlassIcon as MagnifyingGlass, XIcon as X } from "@phosphor-icons/react";
import type { ComponentChildren } from "preact";
import { signal } from "@preact/signals";
import { project, selectedMediaId, selectedCaptionIndex, pushHistory } from "../../store/app";
import {
  newProjectGuarded,
  openProjectGuarded,
  openRecent,
  importMedia,
  relinkMediaItem,
  fileExists,
  VIDEO_EXTS,
} from "../../lib/project";
import { recentProjects } from "../../lib/recent";
import { showContextMenu } from "../ContextMenu";
import { hideTooltip } from "../Tooltip";
import { mediaSettingsId } from "../MediaSettings";
import { sortMedia, type SortMode, type SortDir } from "../../lib/mediaSort";
import type { MediaItem } from "../../types/project";

const missingIds = signal<ReadonlySet<string>>(new Set());

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

function setSortMode(mode: SortMode) {
  sortMode.value = mode;
  localStorage.setItem(SORT_MODE_KEY, mode);
}
function setSortDir(dir: SortDir) {
  sortDir.value = dir;
  localStorage.setItem(SORT_DIR_KEY, dir);
}

/** Apply the active sort + filter to a media array, as the panel displays it.
 *  Shared by the render and by removeMedia's selection fallback so both agree
 *  on "visible order". */
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

function removeMedia(mediaId: string) {
  const proj = project.value;
  if (!proj) return;
  const wasSelected = selectedMediaId.value === mediaId;
  // When removing the selected item, move selection to the next neighbour in
  // *visible* (sorted/filtered) order — under a non-default sort or active
  // filter the media array order diverges from what the user sees, so a plain
  // updated[0] could land on an off-screen or filtered-out row.
  let nextId = selectedMediaId.value;
  if (wasSelected) {
    const visibleBefore = visibleOrder(proj.media);
    const pos = visibleBefore.findIndex((m) => m.id === mediaId);
    nextId = visibleBefore[pos + 1]?.id ?? visibleBefore[pos - 1]?.id ?? null;
  }
  const updated = proj.media.filter((m) => m.id !== mediaId);
  // Record the post-op selection so redo lands on the neighbour, not the
  // now-deleted id — pushHistory otherwise snapshots the current selection,
  // which is still the removed item at this point.
  pushHistory({ ...proj, media: updated }, "Remove media", {
    selectedMediaId: nextId,
    selectedCaptionIndex: selectedCaptionIndex.value,
  });
  if (wasSelected) selectedMediaId.value = nextId;
}

export function ProjectPanel() {
  const proj = project.value;
  const selectedId = selectedMediaId.value;
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
        ) : (
          <div class="media-list">
            {visibleMedia.map((item) => (
              <MediaRow
                key={item.id}
                item={item}
                query={query}
                selected={item.id === selectedId}
                missing={missingIds.value.has(item.id)}
                onClick={() => { selectedMediaId.value = item.id; }}
                onContextMenu={(e) => {
                  showContextMenu(e, [
                    {
                      label: "Settings…",
                      onClick: () => { mediaSettingsId.value = item.id; },
                    },
                    {
                      label: "Re-link file…",
                      onClick: () => relinkMediaItem(item.id),
                    },
                    {
                      label: "Remove from project",
                      danger: true,
                      onClick: () => removeMedia(item.id),
                    },
                  ]);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MediaRow({ item, query, selected, missing, onClick, onContextMenu }: {
  item: MediaItem;
  query: string;
  selected: boolean;
  missing: boolean;
  onClick: () => void;
  onContextMenu: (e: MouseEvent) => void;
}) {
  const meta = missing
    ? "File not found"
    : item.captions.length > 0
      ? `${item.captions.length} captions`
      : "No captions";

  const fpsLabel = item.fps != null
    ? `${item.fps} fps${item.dropFrame != null ? (item.dropFrame ? " DF" : " NDF") : ""}`
    : null;

  return (
    <button
      class={`media-row ${selected ? "media-row--selected" : ""} ${missing ? "media-row--missing" : ""}`}
      data-tooltip={`${item.name}\n${item.path}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
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
