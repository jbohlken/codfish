import { invoke } from "@tauri-apps/api/core";
import { signal } from "@preact/signals";

export interface RecentProject {
  path: string;
  name: string;
  openedAt: string;
}

/** Reactive copy of the persisted recent-projects list. Source of truth on
 *  disk is `recent.json` in the app data dir; this signal mirrors it after
 *  loadRecent() / addRecent() / clearRecent() touch the Rust side. */
export const recentProjects = signal<RecentProject[]>([]);

/** Read recent.json (with on-disk pruning of missing files) and seed the
 *  signal. Call once at app boot. */
export async function loadRecent(): Promise<void> {
  try {
    const list = await invoke<RecentProject[]>("get_recent_projects");
    recentProjects.value = list;
  } catch {
    recentProjects.value = [];
  }
}

/** Record a project as the most-recently-opened. Called from loadIntoStore
 *  so every code path that loads a project (open, new, file association,
 *  open-recent itself, recovery restore) updates the list automatically. */
export async function addRecent(path: string, name: string): Promise<void> {
  try {
    const list = await invoke<RecentProject[]>("add_recent_project", { path, name });
    recentProjects.value = list;
  } catch {
    /* non-critical — silent failure is fine */
  }
}

export async function clearRecent(): Promise<void> {
  try {
    await invoke("clear_recent_projects");
    recentProjects.value = [];
  } catch {
    /* swallow */
  }
}
