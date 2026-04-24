import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  sidecarStatus,
  isDirty,
  project,
  projectPath,
  selectedMediaId,
  selectedCaptionIndex,
  playbackTime,
  isPlaying,
  mediaDuration,
  resetHistory,
} from "../store/app";
import { startDaemon } from "./Splash";
import { saveCurrentProject } from "../lib/project";
import { confirmUnsavedChanges, unsavedChanges } from "./UnsavedChanges";
import { clearRecovery } from "../lib/recovery";
import { showError } from "./ErrorModal";
import { cancelActiveEdit } from "./layout/CaptionPanel";

type SidecarPhase = "downloading" | "extracting" | "finishing";

interface AppUpdateState {
  version: string;
  installing: boolean;
  progress: number | null;
}

interface SidecarUpdateState {
  current: string;
  latest: string;
  variant: string;
  downloading: boolean;
  phase: SidecarPhase;
  progress: number | null;
}

export const appUpdate = signal<AppUpdateState | null>(null);
export const sidecarUpdate = signal<SidecarUpdateState | null>(null);
const popoverOpen = signal(false);

/** Returns true if any update is available or in progress */
export function hasUpdate(): boolean {
  return appUpdate.value !== null || sidecarUpdate.value !== null;
}

/** Returns true if any update is actively installing/downloading */
export function isUpdating(): boolean {
  return (appUpdate.value?.installing ?? false) || (sidecarUpdate.value?.downloading ?? false);
}

/** Close the currently open project entirely. Used before an update tears things down. */
function closeCurrentProject(): void {
  cancelActiveEdit();
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

/**
 * Gate before any update: if a project is open, force the user to either
 * save & close it, or cancel the update. No half-states, no unsaved work
 * hanging around while the engine/app is being replaced underneath.
 */
export async function gateForUpdate(kind: "app" | "engine"): Promise<boolean> {
  if (!project.value) return true;

  const what = kind === "app" ? "Codfish" : "the transcription engine";
  const message = isDirty.value
    ? `Your project will be closed to update ${what}. Save your changes first?`
    : `Your project will be closed to update ${what}. Continue?`;

  const choice = await confirmUnsavedChanges(message, {
    title: "Close project to update?",
    hideDiscard: true,
    confirmLabel: isDirty.value ? "Save & close" : "Close project",
  });
  if (choice === "cancel") return false;
  if (isDirty.value) {
    const ok = await saveCurrentProject();
    if (!ok) return false;
  }
  closeCurrentProject();
  return true;
}

/** Hook that sets up update checking — call once at app root */
export function useUpdateChecker() {
  // Check for app updates after 5s
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const available = await check();
        if (available) {
          appUpdate.value = {
            version: available.version,
            installing: false,
            progress: null,
          };
        }
      } catch {}
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  // Watch for sidecar update_available status
  useEffect(() => {
    if (sidecarStatus.value === "update_available") {
      invoke("check_sidecar_update").then((result: any) => {
        if (result.status === "update_available") {
          sidecarUpdate.value = {
            current: result.current,
            latest: result.latest,
            variant: result.variant,
            downloading: false,
            phase: "downloading",
            progress: null,
          };
        }
      }).catch(() => {});
    }
  }, [sidecarStatus.value]);

  // Listen for sidecar download progress
  useEffect(() => {
    const unlisten = listen<any>("sidecar://download-progress", (e) => {
      const state = sidecarUpdate.value;
      // Only honor download events while we're actually in the download phase —
      // otherwise a late/buffered event can stomp on a later phase.
      if (state?.downloading && state.phase === "downloading") {
        sidecarUpdate.value = { ...state, progress: e.payload.percent };
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  // Listen for sidecar extract progress
  useEffect(() => {
    const unlisten = listen<any>("sidecar://extract-progress", (e) => {
      const state = sidecarUpdate.value;
      // Extract events flip us out of the download phase the first time one
      // arrives, then keep updating progress within that phase.
      if (state?.downloading && state.phase !== "finishing") {
        sidecarUpdate.value = { ...state, phase: "extracting", progress: e.payload.percent };
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, []);
}

const handleAppInstall = async () => {
  const state = appUpdate.value;
  if (!state) return;
  if (!(await gateForUpdate("app"))) return;
  popoverOpen.value = false;
  appUpdate.value = { ...state, installing: true, progress: 0 };

  try {
    const available = await check();
    if (!available) {
      // Rare: something flipped between the initial check and now.
      appUpdate.value = null;
      return;
    }

    let totalBytes = 0;
    let downloadedBytes = 0;

    await available.downloadAndInstall((event) => {
      if (event.event === "Started" && event.data.contentLength) {
        totalBytes = event.data.contentLength;
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        const percent = totalBytes > 0
          ? Math.round((downloadedBytes / totalBytes) * 100)
          : 0;
        appUpdate.value = { ...state, installing: true, progress: percent };
      } else if (event.event === "Finished") {
        appUpdate.value = { ...state, installing: true, progress: 100 };
      }
    });

    await clearRecovery();
    await relaunch();
  } catch (e) {
    const msg = typeof e === "string" ? e : (e as any)?.message ?? String(e);
    appUpdate.value = { ...state, installing: false, progress: null };
    showError(`App update failed: ${msg}`);
  }
};

/**
 * Shared install routine used by both the update flow and the manual
 * variant switcher in the help modal. Caller is responsible for calling
 * gateForUpdate first. `latestVersion` is just for the blocker label.
 */
async function runSidecarInstall(variant: string, latestVersion: string): Promise<void> {
  popoverOpen.value = false;
  sidecarUpdate.value = {
    current: "",
    latest: latestVersion,
    variant,
    downloading: true,
    phase: "downloading",
    progress: 0,
  };
  try {
    // Kill the running daemon first — Windows locks the executable while
    // the process is alive. We do NOT set daemonStatus to "checking" here:
    // App.tsx's auto-start effect would immediately respawn the daemon and
    // re-lock the exe before we could overwrite it.
    await invoke("stop_daemon");
    await invoke("download_sidecar", { variant });
    // Extraction complete — flip to finishing for the blocker label.
    sidecarUpdate.value = {
      current: "",
      latest: latestVersion,
      variant,
      downloading: true,
      phase: "finishing",
      progress: 100,
    };
    sidecarStatus.value = "ready";
    await new Promise((r) => setTimeout(r, 600));
    await startDaemon();
    await clearRecovery();
    sidecarUpdate.value = null;
  } catch (e) {
    const msg = typeof e === "string" ? e : (e as any)?.message ?? String(e);
    const phaseAtFailure = sidecarUpdate.value?.phase ?? "downloading";
    sidecarUpdate.value = null;
    showError(`Transcription engine install failed: ${msg}`);
    if (phaseAtFailure === "downloading") {
      await startDaemon().catch(() => {});
    } else if (phaseAtFailure === "extracting") {
      sidecarStatus.value = "not_installed";
    }
  }
}

/** Manual variant switch from the help modal. */
export async function switchSidecarVariant(variant: "cpu" | "cuda"): Promise<void> {
  if (!(await gateForUpdate("engine"))) return;
  // We don't know the manifest version here; the blocker just shows "engine".
  await runSidecarInstall(variant, "");
}

const handleSidecarUpdate = async () => {
  const state = sidecarUpdate.value;
  if (!state) return;
  if (!(await gateForUpdate("engine"))) return;
  await runSidecarInstall(state.variant, state.latest);
};

export function toggleUpdatePopover() {
  popoverOpen.value = !popoverOpen.value;
}

export function UpdatePopover() {
  const ref = useRef<HTMLDivElement>(null);
  const app = appUpdate.value;
  const sc = sidecarUpdate.value;

  // Close on outside click
  useEffect(() => {
    if (!popoverOpen.value) return;
    const handler = (e: MouseEvent) => {
      // Ignore clicks while the gate modal is up — otherwise cancelling
      // the modal via backdrop/buttons would also close the popover behind it.
      if (unsavedChanges.value) return;
      // Ignore clicks on the trigger button itself — otherwise this handler
      // fires before the button's click, closing the popover, and then the
      // button's onClick toggles it right back open.
      const target = e.target as HTMLElement | null;
      if (target?.closest(".update-icon-wrapper")) return;
      if (ref.current && !ref.current.contains(target as Node)) {
        popoverOpen.value = false;
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [popoverOpen.value]);

  if (!popoverOpen.value || (!app && !sc)) return null;

  // While an update is running the blocker owns the UI; don't duplicate here.
  if (isUpdating()) return null;

  return (
    <div class="update-popover" ref={ref}>
      <div class="update-popover-header">Updates Available</div>
      {app && (
        <div class="update-popover-item">
          <div class="update-popover-info">
            <span class="update-popover-label">Codfish</span>
            <span class="update-popover-version">v{app.version}</span>
            <a
              href="#"
              class="update-popover-link"
              onClick={(e) => {
                e.preventDefault();
                openUrl(`https://github.com/jbohlken/codfish/releases/tag/v${app.version}`);
              }}
            >See what's new</a>
          </div>
          <button class="btn btn-primary btn-sm" onClick={handleAppInstall}>Update</button>
        </div>
      )}
      {sc && (
        <div class="update-popover-item">
          <div class="update-popover-info">
            <span class="update-popover-label">Transcription engine</span>
            <span class="update-popover-version">v{sc.latest}</span>
          </div>
          <button class="btn btn-primary btn-sm" onClick={handleSidecarUpdate}>Update</button>
        </div>
      )}
    </div>
  );
}

/** Full-screen blocker shown while an update is actively installing/downloading,
 *  so the user can't edit state that's about to be torn down under them. */
export function UpdateBlocker() {
  if (!isUpdating()) return null;
  const app = appUpdate.value;
  const sc = sidecarUpdate.value;

  let label = "Updating…";
  let progress: number | null = null;
  if (app?.installing) {
    label = app.progress === 100
      ? `Installing Codfish v${app.version}…`
      : `Downloading Codfish v${app.version}…`;
    progress = app.progress;
  } else if (sc?.downloading) {
    if (sc.phase === "downloading") label = "Downloading transcription engine…";
    else if (sc.phase === "extracting") label = "Extracting transcription engine…";
    else label = "Finalizing transcription engine…";
    progress = sc.progress;
  }

  return (
    <div class="update-blocker">
      <div class="update-blocker-card">
        <div class="update-blocker-label">{label}</div>
        {progress !== null && progress !== undefined && (
          <div class="update-popover-bar">
            <div class="update-popover-bar-fill" style={{ width: `${progress}%` }} />
          </div>
        )}
        <div class="update-blocker-hint">Please don't close the app.</div>
      </div>
    </div>
  );
}
