import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { project, projectPath, isDirty, selectedMediaId, selectedCaptionIndex, playbackTime, isPlaying, mediaDuration, pushHistory, resetHistory } from "../../store/app";
import { showError } from "../../components/ErrorModal";
import { confirmUnsavedChanges } from "../../components/UnsavedChanges";
import { clearRecovery } from "../recovery";
import type { CodProject, MediaItem } from "../../types/project";

const PROJECT_VERSION = 1;

const VIDEO_EXTS = ["mp4", "mov", "mkv", "avi", "webm"];
const AUDIO_EXTS = ["mp3", "wav", "m4a", "aac", "flac", "ogg"];
const MEDIA_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS];

// ── Public actions ────────────────────────────────────────────────────────────

/** Check for unsaved changes, prompt if needed, then run action.
 *  If the user picks save or discard, the current project is closed
 *  *before* the action runs — so cancelling a follow-up file dialog
 *  leaves the app with no project open, not half the old one. */
export async function withUnsavedCheck(action: () => Promise<boolean>): Promise<boolean> {
  if (isDirty.value && project.value) {
    const choice = await confirmUnsavedChanges();
    if (choice === "cancel") return false;
    if (choice === "save") {
      const saved = await saveCurrentProject();
      if (!saved) return false;
    } else if (choice === "discard") {
      await clearRecovery();
    }
    closeProject();
  } else if (project.value) {
    // Clean project — still close it so the action starts from a clean slate.
    closeProject();
  }
  return action();
}

/** Clear the current project from the store. Does not touch disk. */
function closeProject(): void {
  resetHistory();
  project.value = null;
  projectPath.value = null;
  isDirty.value = false;
  selectedMediaId.value = null;
  selectedCaptionIndex.value = null;
  playbackTime.value = 0;
  isPlaying.value = false;
  mediaDuration.value = 0;
}

export function newProjectGuarded(): Promise<boolean> {
  return withUnsavedCheck(newProject);
}

export function openProjectGuarded(): Promise<boolean> {
  return withUnsavedCheck(openProject);
}

export async function newProject(): Promise<boolean> {
  const savePath = await save({
    title: "New Project",
    filters: [{ name: "Codfish Project", extensions: ["cod"] }],
    defaultPath: "Untitled.cod",
  });
  if (!savePath) return false;

  const name = pathToName(savePath);
  const now = new Date().toISOString();
  const proj: CodProject = {
    version: PROJECT_VERSION,
    name,
    profileId: "default",
    transcriptionModel: "base",
    language: "",
    exportFormatId: "SRT",
    createdAt: now,
    updatedAt: now,
    media: [],
  };

  await writeToDisk(savePath, proj);
  loadIntoStore(proj, savePath);
  return true;
}

export async function loadProjectFromPath(filePath: string): Promise<boolean> {
  const json = await invoke<string>("load_project", { path: filePath });
  const proj = JSON.parse(json) as CodProject;

  // Migrate old project files
  if (!(proj as any).transcriptionModel) {
    proj.transcriptionModel = (proj.media[0] as any)?.transcriptionModel ?? "base";
  }
  if (!(proj as any).language) {
    proj.language = (proj.media[0] as any)?.language ?? "";
  }
  proj.media = proj.media.map((m) => {
    const { language: _l, transcriptionModel: _t, fps, captions, ...rest } = m as any;
    return {
      ...rest,
      fps: fps ?? null,
      captions: captions.map(({ words: _w, ...c }: any) => c),
    };
  });

  loadIntoStore(proj, filePath);
  return true;
}

export async function openProject(): Promise<boolean> {
  const result = await open({
    title: "Open Project",
    filters: [{ name: "Codfish Project", extensions: ["cod"] }],
    multiple: false,
  });
  const filePath = flattenDialogResult(result);
  if (!filePath) return false;
  return loadProjectFromPath(filePath);
}

export async function saveCurrentProject(): Promise<boolean> {
  const proj = project.value;
  const path = projectPath.value;

  if (!proj) return false;

  // No path yet — shouldn't happen with new/open flow, but fall back to Save As
  if (!path) return saveCurrentProjectAs();

  await writeToDisk(path, proj);
  isDirty.value = false;
  await clearRecovery();
  return true;
}

export async function saveCurrentProjectAs(): Promise<boolean> {
  const proj = project.value;
  if (!proj) return false;

  const savePath = await save({
    title: "Save Project As",
    filters: [{ name: "Codfish Project", extensions: ["cod"] }],
    defaultPath: `${proj.name}.cod`,
  });
  if (!savePath) return false;

  const name = pathToName(savePath);
  const updated: CodProject = { ...proj, name };
  await writeToDisk(savePath, updated);
  project.value = updated;
  projectPath.value = savePath;
  isDirty.value = false;
  await clearRecovery();
  return true;
}

export async function importMedia(): Promise<void> {
  const proj = project.value;
  if (!proj) return;

  const result = await open({
    title: "Import Media",
    filters: [{ name: "Video & Audio", extensions: MEDIA_EXTS }],
    multiple: true,
  });
  if (!result) return;

  const paths = Array.isArray(result) ? result : [result];
  if (paths.length === 0) return;

  const newItems = await Promise.all(
    paths.map(async (p) => {
      const item = makeMediaItem(p);
      item.fps = await probeFps(p);
      return item;
    })
  );
  const label = newItems.length === 1 ? `Import "${newItems[0].name}"` : `Import ${newItems.length} files`;
  pushHistory({
    ...proj,
    media: [...proj.media, ...newItems],
  }, label);

  // Auto-select the first imported item
  selectedMediaId.value = newItems[0].id;
}

export async function relinkMediaItem(mediaId: string): Promise<void> {
  const proj = project.value;
  if (!proj) return;

  const result = await open({
    title: "Re-link Media File",
    filters: [{ name: "Video & Audio", extensions: MEDIA_EXTS }],
    multiple: false,
  });
  const newPath = flattenDialogResult(result);
  if (!newPath) return;

  const fps = await probeFps(newPath);

  pushHistory({
    ...proj,
    media: proj.media.map((m) =>
      m.id !== mediaId ? m : { ...m, path: newPath, name: pathToBasename(newPath), fps }
    ),
  }, "Re-link media");
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    return await invoke<boolean>("file_exists", { path });
  } catch {
    return false;
  }
}

export async function probeFps(path: string): Promise<number | null> {
  try {
    return await invoke<number | null>("probe_fps", { path });
  } catch (e: any) {
    const msg = typeof e === "string" ? e : e?.message || "Unknown error probing frame rate";
    showError(msg);
    return null;
  }
}

export function makeMediaItem(filePath: string): MediaItem {
  return {
    id: crypto.randomUUID(),
    name: pathToBasename(filePath),
    path: filePath,
    fps: null,
    captions: [],
    exports: [],
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function writeToDisk(filePath: string, proj: CodProject): Promise<void> {
  const toSave: CodProject = {
    ...proj,
    updatedAt: new Date().toISOString(),
    // Strip `words` arrays — they are runtime-only
    media: proj.media.map((m) => ({
      ...m,
      captions: m.captions.map(({ words: _w, ...c }) => c),
    })),
  };
  await invoke<void>("save_project", { path: filePath, json: JSON.stringify(toSave, null, 2) });
}

function loadIntoStore(proj: CodProject, filePath: string): void {
  resetHistory(proj);
  project.value = proj;
  projectPath.value = filePath;
  isDirty.value = false;
  selectedMediaId.value = null;
  selectedCaptionIndex.value = null;
  playbackTime.value = 0;
  isPlaying.value = false;
}

function flattenDialogResult(result: string | string[] | null): string | null {
  if (!result) return null;
  return Array.isArray(result) ? (result[0] ?? null) : result;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function pathToBasename(filePath: string): string {
  const normalized = normalizePath(filePath);
  const base = normalized.split("/").pop() ?? filePath;
  // Strip extension
  return base.replace(/\.[^.]+$/, "");
}

function pathToName(filePath: string): string {
  const normalized = normalizePath(filePath);
  const base = normalized.split("/").pop() ?? "Untitled";
  return base.endsWith(".cod") ? base.slice(0, -4) : base;
}
