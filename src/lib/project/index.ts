import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { project, projectPath, isDirty, selectedMediaId, selectedCaptionIndex, playbackTime, isPlaying, mediaDuration, pushHistory, resetHistory } from "../../store/app";
import { showError } from "../../components/ErrorModal";
import { confirmUnsavedChanges } from "../../components/UnsavedChanges";
import { clearRecovery } from "../recovery";
import { addRecent, loadRecent } from "../recent";
import { hashContent } from "../hash";
import { selectedExportFormat, exportFormats } from "../../store/app";
import { loadFormatSource, listFormats } from "../export";
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
    // Clear recovery too: a clean project has no unsaved work, so any leftover
    // recovery blob is stale and would just confuse the next boot.
    await clearRecovery();
    closeProject();
  }
  return action();
}

/** Run the unsaved-changes gate, then clear the current project. Returns
 *  true if the project was closed (or was already absent). Thin wrapper
 *  over withUnsavedCheck — the noop action just signals "nothing to do
 *  after closing". */
export function closeProjectGuarded(): Promise<boolean> {
  return withUnsavedCheck(async () => true);
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

  const name = pathToBasename(savePath);
  const now = new Date().toISOString();
  const proj: CodProject = {
    version: PROJECT_VERSION,
    name,
    profileId: "default",
    transcriptionModel: "base",
    language: "",
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
  loadIntoStore(proj, filePath);
  return true;
}

/** Open a project from the recent list. If the file no longer exists,
 *  refresh the recent list (which prunes missing entries) and surface an
 *  error — without closing the currently open project. */
export async function openRecent(filePath: string): Promise<boolean> {
  if (!(await fileExists(filePath))) {
    await loadRecent();
    showError(`File not found:\n${filePath}`);
    return false;
  }
  return withUnsavedCheck(async () => {
    try { await loadProjectFromPath(filePath); return true; }
    catch (err) { console.error(err); return false; }
  });
}

async function openProject(): Promise<boolean> {
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

  const name = pathToBasename(savePath);
  const updated: CodProject = { ...proj, name };
  await writeToDisk(savePath, updated);
  project.value = updated;
  projectPath.value = savePath;
  isDirty.value = false;
  await clearRecovery();
  // Save As switches the working file to the new path, so treat it like
  // any other load for recents purposes — otherwise the new file wouldn't
  // show up in File ▸ Open Recent until the user closes and reopens it.
  void addRecent(savePath);
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

async function getFormatReference(): Promise<{ name: string; hash: string } | null> {
  try {
    const name = selectedExportFormat.value;
    const format = exportFormats.value.find((f) => f.name === name);
    if (!format) return null;
    const source = await loadFormatSource(format.formatPath);
    const hash = await hashContent(source);
    return { name: format.name, hash };
  } catch {
    return null;
  }
}

async function writeToDisk(filePath: string, proj: CodProject): Promise<void> {
  const formatRef = await getFormatReference();
  const toSave: CodProject = {
    ...proj,
    updatedAt: new Date().toISOString(),
    exportFormatName: formatRef?.name,
    exportFormatHash: formatRef?.hash,
    // Strip `words` arrays — they are runtime-only
    media: proj.media.map((m) => ({
      ...m,
      captions: m.captions.map(({ words: _w, ...c }) => c),
    })),
  };
  // Remove format fields entirely if no valid reference, so we never
  // serialize null into the JSON (which would persist as a bogus value).
  if (!toSave.exportFormatName) {
    delete toSave.exportFormatName;
    delete toSave.exportFormatHash;
  }
  await invoke<void>("save_project", { path: filePath, json: JSON.stringify(toSave, null, 2) });
}

export async function checkFormatCompatibility(proj: CodProject): Promise<void> {
  try {
    const formats = await listFormats();
    if (!proj.exportFormatName) {
      // Old project with no format reference — default to SRT or first available.
      selectedExportFormat.value = formats.find((f) => f.name === "SRT")?.name ?? formats[0]?.name ?? "SRT";
      return;
    }
    const match = formats.find((f) => f.name === proj.exportFormatName);
    if (!match) {
      selectedExportFormat.value = formats.find((f) => f.name === "SRT")?.name ?? formats[0]?.name ?? "SRT";
      showError(`This project uses export format "${proj.exportFormatName}", which isn't installed.`);
      return;
    }
    // Format exists — select it.
    selectedExportFormat.value = match.name;
    if (!proj.exportFormatHash) return;
    const source = await loadFormatSource(match.formatPath);
    const hash = await hashContent(source);
    if (hash !== proj.exportFormatHash) {
      showError(`This project uses export format "${proj.exportFormatName}", but your local version differs.`);
    }
  } catch {
    // Format check is best-effort — never block project loading.
  }
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
  // Fire-and-forget: every code path that loads a project (open, new, file
  // association, open-recent, recovery restore) flows through here, so this
  // is the single place to update the recent list.
  void addRecent(filePath);
  void checkFormatCompatibility(proj);
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

