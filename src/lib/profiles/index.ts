import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { CaptionProfile } from "../../types/profile";

/** Load all profiles from the app data profiles directory. */
export async function loadProfiles(): Promise<CaptionProfile[]> {
  try {
    return await invoke<CaptionProfile[]>("list_profiles");
  } catch {
    return [];
  }
}

/** Save a profile to disk (creates or overwrites). */
export async function saveProfile(profile: CaptionProfile): Promise<void> {
  await invoke<void>("save_profile", { profile });
}

/** Delete a profile from disk. */
export async function deleteProfile(id: string): Promise<void> {
  await invoke<void>("delete_profile", { id });
}

/** Open the profiles directory in the system file manager. */
export async function openProfilesDir(): Promise<void> {
  const dir = await invoke<string>("get_profiles_dir");
  await invoke<void>("open_in_explorer", { path: dir });
}

/** Export a profile to a user-chosen location via save dialog. */
export async function exportProfile(id: string): Promise<void> {
  const json = await invoke<string>("export_profile", { id });
  const { content, defaultName } = JSON.parse(json);

  const filePath = await save({
    defaultPath: `${defaultName}.cfp`,
    filters: [{ name: "Codfish Profile", extensions: ["cfp"] }],
  });
  if (!filePath) return;

  // Write via Rust since we already have the content
  await invoke<void>("save_project", { path: filePath, json: content });
}

/** Import a profile from a user-chosen .cfp file. Returns the new profile, or null if cancelled. */
export async function importProfile(): Promise<CaptionProfile | null> {
  const result = await open({
    filters: [{ name: "Codfish Profile", extensions: ["cfp"] }],
    multiple: false,
  });
  if (!result) return null;

  const filePath = typeof result === "string" ? result : result;
  const content = await invoke<string>("load_project", { path: filePath });
  return await invoke<CaptionProfile>("import_profile", { content });
}
