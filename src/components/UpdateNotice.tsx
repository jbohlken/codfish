import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sidecarStatus, daemonStatus } from "../store/app";
import { startDaemon } from "./Splash";

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
      if (state?.downloading) {
        sidecarUpdate.value = { ...state, progress: e.payload.percent };
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, []);
}

const handleAppInstall = async () => {
  const state = appUpdate.value;
  if (!state) return;
  appUpdate.value = { ...state, installing: true, progress: 0 };

  try {
    const available = await check();
    if (!available) return;

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

    await relaunch();
  } catch {
    appUpdate.value = { ...state, installing: false, progress: null };
  }
};

const handleSidecarUpdate = async () => {
  const state = sidecarUpdate.value;
  if (!state) return;
  sidecarUpdate.value = { ...state, downloading: true, progress: 0 };
  try {
    // Kill the running daemon first — Windows locks the executable while
    // the process is alive, so we can't replace it otherwise.
    await invoke("stop_daemon");
    daemonStatus.value = "checking";
    await invoke("download_sidecar", { variant: state.variant });
    sidecarUpdate.value = null;
    sidecarStatus.value = "ready";
    // Respawn against the freshly extracted binary.
    await startDaemon();
  } catch (e) {
    sidecarUpdate.value = { ...state, downloading: false, progress: null };
    // Bring the old daemon back so the user isn't stranded.
    await startDaemon().catch(() => {});
    console.error("sidecar update failed:", e);
  }
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
      if (ref.current && !ref.current.contains(e.target as Node)) {
        popoverOpen.value = false;
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [popoverOpen.value]);

  if (!popoverOpen.value || (!app && !sc)) return null;

  return (
    <div class="update-popover" ref={ref}>
      <div class="update-popover-header">Updates Available</div>
      {app && (
        <div class="update-popover-item">
          {app.installing ? (
            <div class="update-popover-progress">
              <span>Installing v{app.version}...</span>
              {app.progress !== null && (
                <div class="update-popover-bar">
                  <div class="update-popover-bar-fill" style={{ width: `${app.progress}%` }} />
                </div>
              )}
            </div>
          ) : (
            <>
              <div class="update-popover-info">
                <span class="update-popover-label">Codfish</span>
                <span class="update-popover-version">v{app.version}</span>
              </div>
              <button class="btn btn-primary btn-sm" onClick={handleAppInstall} disabled={sc?.downloading}>Update</button>
            </>
          )}
        </div>
      )}
      {sc && (
        <div class="update-popover-item">
          {sc.downloading ? (
            <div class="update-popover-progress">
              <span>Updating engine...</span>
              {sc.progress !== null && (
                <div class="update-popover-bar">
                  <div class="update-popover-bar-fill" style={{ width: `${sc.progress}%` }} />
                </div>
              )}
            </div>
          ) : (
            <>
              <div class="update-popover-info">
                <span class="update-popover-label">Transcription engine</span>
                <span class="update-popover-version">v{sc.latest}</span>
              </div>
              <button class="btn btn-primary btn-sm" onClick={handleSidecarUpdate} disabled={app?.installing}>Update</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
