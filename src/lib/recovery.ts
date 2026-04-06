import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "preact/hooks";
import { project, projectPath, isDirty } from "../store/app";
import { isUpdating } from "../components/UpdateNotice";

interface RecoveryBlob {
  original_path: string | null;
  saved_at: string;
  json: string;
}

/** Snapshot the current in-memory project into the recovery file. No-op if nothing loaded. */
export async function saveRecoveryNow(): Promise<void> {
  const proj = project.value;
  if (!proj) return;
  try {
    await invoke("save_recovery", {
      json: JSON.stringify(proj),
      originalPath: projectPath.value,
    });
  } catch (e) {
    console.error("saveRecoveryNow failed", e);
  }
}

export async function loadRecovery(): Promise<RecoveryBlob | null> {
  try {
    return await invoke<RecoveryBlob | null>("load_recovery");
  } catch {
    return null;
  }
}

export async function clearRecovery(): Promise<void> {
  try {
    await invoke("clear_recovery");
  } catch {}
}

/** Autosave recovery every `intervalMs` while the project is dirty. */
export function useAutosaveRecovery(intervalMs = 30_000): void {
  useEffect(() => {
    const t = setInterval(() => {
      // Don't overwrite the snapshot mid-update — the gate already took
      // one and any further writes would capture a stale/closed project.
      if (isUpdating()) return;
      if (isDirty.value) saveRecoveryNow();
    }, intervalMs);
    return () => clearInterval(t);
  }, []);
}
