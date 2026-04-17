import { signal, computed } from "@preact/signals";
import type { CodProject, MediaItem, CaptionBlock } from "../types/project";
import type { CaptionProfile } from "../types/profile";
import type { ExportFormat } from "../lib/export";

// ── Project ────────────────────────────────────────────────────────────────
export const project = signal<CodProject | null>(null);
export const projectPath = signal<string | null>(null);
export const isDirty = signal(false);

// ── Selection ──────────────────────────────────────────────────────────────
export const selectedMediaId = signal<string | null>(null);
export const selectedCaptionIndex = signal<number | null>(null);

// ── Playback ───────────────────────────────────────────────────────────────
export const playbackTime = signal(0);   // seconds
export const isPlaying = signal(false);
export const mediaDuration = signal(0);  // seconds — set from loadedmetadata

// ── Profiles ───────────────────────────────────────────────────────────────
export const profiles = signal<CaptionProfile[]>([]);
export const selectedProfile = signal<string>("Codfish");

// ── Export formats ────────────────────────────────────────────────────────
export const exportFormats = signal<ExportFormat[]>([]);
export const selectedExportFormat = signal<string>("SRT");

// ── Sidecar ──────────��────────────────────────────────────────────────────
export type SidecarState = "checking" | "not_installed" | "downloading" | "ready" | "update_available";
export const sidecarStatus = signal<SidecarState>("checking");

// ── Daemon (long-lived sidecar process) ────────────────────────────────────
export type DaemonState = "checking" | "booting" | "ready" | "crashed" | "not_installed";
export const daemonStatus = signal<DaemonState>("checking");
export const daemonError = signal<string | null>(null);

// ── Undo / Redo ────────────────────────────────────────────────────────────

interface HistoryEntry {
  project: CodProject;
  description: string;
  // "Before" selection: where the op that produced this state was performed.
  // Used by undo so the user sees what just reverted.
  selectedMediaId: string | null;
  selectedCaptionIndex: number | null;
  // "After" selection: natural selection for this state post-op. Used by redo
  // so re-applied delete/add settle sensibly. Equals the before-selection for
  // ops that don't shift selection (split, merge, edit).
  selectedMediaIdAfter: string | null;
  selectedCaptionIndexAfter: number | null;
}

export interface PostOpSelection {
  selectedMediaId: string | null;
  selectedCaptionIndex: number | null;
}

const _history = signal<HistoryEntry[]>([]);
const _historyIndex = signal(-1);

/** Reset undo/redo history with the initial project state as the baseline. */
export function resetHistory(initial?: CodProject) {
  _pendingAdd = null;
  if (initial) {
    _history.value = [{
      project: initial,
      description: "Open project",
      selectedMediaId: selectedMediaId.value,
      selectedCaptionIndex: selectedCaptionIndex.value,
      selectedMediaIdAfter: selectedMediaId.value,
      selectedCaptionIndexAfter: selectedCaptionIndex.value,
    }];
    _historyIndex.value = 0;
  } else {
    _history.value = [];
    _historyIndex.value = -1;
  }
}

/** Commit a new project state to the undo history and update project.
 *
 * The entry captures both the "before" selection (current signal values at
 * call time — where the op was performed) and the "after" selection for redo.
 * Callers whose op shifts selection (delete, add) pass the new selection
 * explicitly so redo lands correctly; ops that don't shift selection omit it
 * and get symmetric undo/redo. */
export function pushHistory(
  newProject: CodProject,
  description = "Edit",
  postOp?: PostOpSelection,
) {
  const trimmed = _history.value.slice(0, _historyIndex.value + 1);
  _history.value = [...trimmed, {
    project: newProject,
    description,
    selectedMediaId: selectedMediaId.value,
    selectedCaptionIndex: selectedCaptionIndex.value,
    selectedMediaIdAfter: postOp?.selectedMediaId ?? selectedMediaId.value,
    selectedCaptionIndexAfter: postOp?.selectedCaptionIndex ?? selectedCaptionIndex.value,
  }];
  _historyIndex.value = trimmed.length;
  project.value = newProject;
  isDirty.value = true;
}

export function undo() {
  if (_historyIndex.value <= 0) return;
  // Restore selection to where the operation we're undoing happened, so the
  // user can see what changed. Project state rolls back to the previous entry.
  const undone = _history.value[_historyIndex.value];
  _historyIndex.value--;
  const entry = _history.value[_historyIndex.value];
  project.value = entry.project;
  selectedMediaId.value = undone.selectedMediaId;
  selectedCaptionIndex.value = undone.selectedCaptionIndex;
  isDirty.value = true;
}

export function redo() {
  if (_historyIndex.value >= _history.value.length - 1) return;
  _historyIndex.value++;
  const entry = _history.value[_historyIndex.value];
  project.value = entry.project;
  selectedMediaId.value = entry.selectedMediaIdAfter;
  selectedCaptionIndex.value = entry.selectedCaptionIndexAfter;
  isDirty.value = true;
}

// ── Pending add ─────────────────────────────────────────────────────────────
// Add caption doesn't commit to history until the caption has real content.
// This avoids the phantom-caption problem where A-then-Escape leaves an Add
// + Delete pair in history that resurrects on undo.

interface PendingAdd {
  preAddProject: CodProject;
  preAddSelectedMediaId: string | null;
  preAddSelectedCaptionIndex: number | null;
  captionIndex: number;
}

let _pendingAdd: PendingAdd | null = null;

/** Tentatively add a caption: mutate project directly, remember the pre-add
 * snapshot, but do not push history. Must be followed by commitPendingAdd
 * (on non-empty edit) or cancelPendingAdd (on Escape/empty commit). */
export function beginPendingAdd(newProject: CodProject, captionIndex: number) {
  if (!project.value) return;
  if (_pendingAdd) return;
  _pendingAdd = {
    preAddProject: project.value,
    preAddSelectedMediaId: selectedMediaId.value,
    preAddSelectedCaptionIndex: selectedCaptionIndex.value,
    captionIndex,
  };
  project.value = newProject;
}

/** Commit the pending add as a single "Add caption" history entry. The pre-op
 * selection reflects the state before the A was pressed so undo lands there. */
export function commitPendingAdd(newProject: CodProject) {
  if (!_pendingAdd) return;
  const { preAddSelectedMediaId, preAddSelectedCaptionIndex, captionIndex } = _pendingAdd;
  // Restore signals to pre-add so pushHistory captures them as pre-op.
  selectedMediaId.value = preAddSelectedMediaId;
  selectedCaptionIndex.value = preAddSelectedCaptionIndex;
  _pendingAdd = null;
  pushHistory(newProject, "Add caption", {
    selectedMediaId: preAddSelectedMediaId,
    selectedCaptionIndex: captionIndex,
  });
  selectedCaptionIndex.value = captionIndex;
}

/** Revert the pending add without touching history. */
export function cancelPendingAdd() {
  if (!_pendingAdd) return;
  project.value = _pendingAdd.preAddProject;
  selectedMediaId.value = _pendingAdd.preAddSelectedMediaId;
  selectedCaptionIndex.value = _pendingAdd.preAddSelectedCaptionIndex;
  _pendingAdd = null;
}

export function getPendingAddIndex(): number | null {
  return _pendingAdd?.captionIndex ?? null;
}

export const canUndo = computed(() => _historyIndex.value > 0);
export const canRedo = computed(() => _historyIndex.value < _history.value.length - 1);

export const undoDescription = computed<string | null>(() => {
  if (_historyIndex.value <= 0) return null;
  return _history.value[_historyIndex.value]?.description ?? null;
});

export const redoDescription = computed<string | null>(() => {
  const next = _history.value[_historyIndex.value + 1];
  return next?.description ?? null;
});

// ── Derived ────────────────────────────────────────────────────────────────
export const selectedMedia = computed((): MediaItem | null => {
  if (!project.value || !selectedMediaId.value) return null;
  return project.value.media.find((m) => m.id === selectedMediaId.value) ?? null;
});

export const selectedCaption = computed((): CaptionBlock | null => {
  if (!selectedMedia.value || selectedCaptionIndex.value === null) return null;
  return selectedMedia.value.captions.find((c) => c.index === selectedCaptionIndex.value) ?? null;
});

export const activeProfile = computed((): CaptionProfile => {
  const name = selectedProfile.value;
  return profiles.value.find((p) => p.name === name) ?? profiles.value[0];
});
