import { invoke } from "@tauri-apps/api/core";
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
