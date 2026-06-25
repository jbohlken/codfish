/**
 * Per-clip editor view state — the caption selection and playhead position for
 * each media item — remembered so switching clips (and reopening a project)
 * returns you to where you left each one. Persisted in localStorage, keyed by
 * project (the .cod file path, like the bin-collapse state), never written to
 * the .cod itself. It is view state, not document state.
 *
 * Open text-edits are deliberately NOT part of this — they close on switch.
 */

export interface ClipViewState {
  captionIndex: number | null;
  playbackTime: number;    // seconds
  zoom?: number;           // timeline zoom (1 = Fit … 500); omitted = Fit. Optional + additive.
  timelineScroll?: number; // timeline horizontal scroll, px (paired with zoom). Optional + additive.
}

type ClipMap = Record<string, ClipViewState>;   // clipId -> state
type StoredMap = Record<string, ClipMap>;        // projectKey -> clipId -> state

const CLIPVIEW_KEY = "codfish:clipView";
// Bound localStorage growth: keep at most this many projects' entries, evicting
// the least-recently-written when exceeded (mirrors the collapse store).
const MAX_REMEMBERED_PROJECTS = 64;

function isState(v: unknown): v is ClipViewState {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  // This is the single read boundary for hand-edited / corrupt localStorage, so
  // reject values that aren't legitimate (NaN/Infinity/negative time, fractional
  // or negative caption index) rather than letting them reach the editor.
  const captionOk =
    s.captionIndex === null ||
    (typeof s.captionIndex === "number" && Number.isInteger(s.captionIndex) && s.captionIndex >= 0);
  const timeOk = typeof s.playbackTime === "number" && Number.isFinite(s.playbackTime) && s.playbackTime >= 0;
  const zoomOk =
    s.zoom === undefined || (typeof s.zoom === "number" && Number.isFinite(s.zoom) && s.zoom >= 1 && s.zoom <= 500);
  const scrollOk =
    s.timelineScroll === undefined ||
    (typeof s.timelineScroll === "number" && Number.isFinite(s.timelineScroll) && s.timelineScroll >= 0);
  return captionOk && timeOk && zoomOk && scrollOk;
}

/** Parse the whole stored map, dropping anything malformed (a hand-edited /
 *  corrupt entry must never crash a read). */
function loadStored(): StoredMap {
  try {
    const raw = JSON.parse(localStorage.getItem(CLIPVIEW_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const clean: StoredMap = {};
    for (const [projectKey, clips] of Object.entries(raw)) {
      if (!clips || typeof clips !== "object" || Array.isArray(clips)) continue;
      const cm: ClipMap = {};
      for (const [clipId, state] of Object.entries(clips as Record<string, unknown>)) {
        if (isState(state)) cm[clipId] = state;
      }
      if (Object.keys(cm).length) clean[projectKey] = cm;
    }
    return clean;
  } catch {
    return {};
  }
}

let currentKey: string | null = null;
let current: ClipMap = {};

/** Swap the active per-clip state to the given project's, pruned to the clips
 *  that still exist (`liveIds`). Call whenever the open project changes (null
 *  when none) — mirrors loadCollapsedForProject. */
export function loadClipViewForProject(projectKey: string | null, liveIds: Set<string>): void {
  currentKey = projectKey;
  if (projectKey === null) {
    current = {};
    return;
  }
  const stored = loadStored()[projectKey] ?? {};
  const pruned: ClipMap = {};
  for (const [id, st] of Object.entries(stored)) if (liveIds.has(id)) pruned[id] = st;
  current = pruned;
}

/** The remembered view state for a clip, or undefined if never recorded. */
export function getClipView(id: string | null | undefined): ClipViewState | undefined {
  return id ? current[id] : undefined;
}

function persist(): void {
  if (currentKey === null) return;
  try {
    const stored = loadStored();
    // Delete-then-reinsert so this project moves to the most-recent slot (the
    // basis for LRU eviction below).
    delete stored[currentKey];
    if (Object.keys(current).length) stored[currentKey] = current;
    const keys = Object.keys(stored);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_PROJECTS))) delete stored[k];
    localStorage.setItem(CLIPVIEW_KEY, JSON.stringify(stored));
  } catch {
    // view state is best-effort
  }
}

/** Record a clip's view state (called when leaving a clip, and on save/close to
 *  flush the open one). Persists immediately — switches are user-paced. */
export function rememberClipView(id: string, state: ClipViewState): void {
  current[id] = state;
  persist();
}

// ── Active clip per project (which clip to reopen on load) ───────────────────
const ACTIVE_CLIP_KEY = "codfish:activeClip";
type ActiveMap = Record<string, string>; // projectKey -> clipId

function loadActiveMap(): ActiveMap {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVE_CLIP_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const clean: ActiveMap = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") clean[k] = v;
    return clean;
  } catch {
    return {};
  }
}

function persistActiveMap(map: ActiveMap): void {
  try {
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_PROJECTS))) delete map[k];
    localStorage.setItem(ACTIVE_CLIP_KEY, JSON.stringify(map));
  } catch {
    // view state is best-effort
  }
}

/** Remember which clip is active in the current project, so loading the project
 *  later reopens it. Pass null to clear (e.g. deselect → next load opens nothing).
 *  Keyed by the active clip-view project; set on every clip switch. */
export function rememberActiveClip(clipId: string | null): void {
  if (currentKey === null) return;
  const map = loadActiveMap();
  delete map[currentKey]; // delete-then-reinsert → most-recent LRU slot
  if (clipId !== null) map[currentKey] = clipId;
  persistActiveMap(map);
}

/** The clip that was active when the given project was last open, or null. */
export function getActiveClip(projectKey: string): string | null {
  return loadActiveMap()[projectKey] ?? null;
}

/** Copy a project's remembered clip-view map to a new storage key, keeping the
 *  original. Save As writes a COPY at a new path while the original file still
 *  exists — both reference the same clip ids, so both should keep their
 *  remembered spots; moving instead would wipe the original's memory on reopen.
 *  The active key follows to the new project (the one now being edited). Flush the
 *  open clip first so its latest spot is included. */
export function copyClipViewProject(oldKey: string, newKey: string): void {
  if (oldKey === newKey) return;
  try {
    const stored = loadStored();
    const map = stored[oldKey];
    if (map) {
      // Delete-then-reinsert newKey so it lands in the most-recent LRU slot.
      delete stored[newKey];
      stored[newKey] = { ...map };
      const keys = Object.keys(stored);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_PROJECTS))) delete stored[k];
      localStorage.setItem(CLIPVIEW_KEY, JSON.stringify(stored));
    }
  } catch {
    // view state is best-effort
  }
  // Carry the active clip too, so Save As resumes the same clip in the new file.
  const active = loadActiveMap();
  if (active[oldKey] !== undefined) {
    delete active[newKey];
    active[newKey] = active[oldKey];
    persistActiveMap(active);
  }
  if (currentKey === oldKey) currentKey = newKey;
}
