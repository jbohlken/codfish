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

// ── Export formats ────────────────────────────────────────────────────────
export const exportFormats = signal<ExportFormat[]>([]);

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
}

const _history = signal<HistoryEntry[]>([]);
const _historyIndex = signal(-1);

/** Reset undo/redo history with the initial project state as the baseline. */
export function resetHistory(initial?: CodProject) {
  if (initial) {
    _history.value = [{ project: initial, description: "Open project" }];
    _historyIndex.value = 0;
  } else {
    _history.value = [];
    _historyIndex.value = -1;
  }
}

/** Commit a new project state to the undo history and update project. */
export function pushHistory(newProject: CodProject, description = "Edit") {
  const trimmed = _history.value.slice(0, _historyIndex.value + 1);
  _history.value = [...trimmed, { project: newProject, description }];
  _historyIndex.value = trimmed.length;
  project.value = newProject;
  isDirty.value = true;
}

export function undo() {
  if (_historyIndex.value <= 0) return;
  _historyIndex.value--;
  project.value = _history.value[_historyIndex.value].project;
  isDirty.value = true;
}

export function redo() {
  if (_historyIndex.value >= _history.value.length - 1) return;
  _historyIndex.value++;
  project.value = _history.value[_historyIndex.value].project;
  isDirty.value = true;
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
  return selectedMedia.value.captions[selectedCaptionIndex.value] ?? null;
});

export const activeProfile = computed((): CaptionProfile => {
  const id = project.value?.profileId ?? "default";
  return profiles.value.find((p) => p.id === id) ?? profiles.value[0];
});
