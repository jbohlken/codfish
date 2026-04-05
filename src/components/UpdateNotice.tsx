import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sidecarStatus } from "../store/app";

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

const appUpdate = signal<AppUpdateState | null>(null);
const sidecarUpdate = signal<SidecarUpdateState | null>(null);
const dismissed = signal(false);

export function UpdateNotice() {
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
      await invoke("download_sidecar", { variant: state.variant });
      sidecarUpdate.value = null;
      sidecarStatus.value = "ready";
    } catch {
      sidecarUpdate.value = { ...state, downloading: false, progress: null };
    }
  };

  if (dismissed.value) return null;

  const app = appUpdate.value;
  const sc = sidecarUpdate.value;
  if (!app && !sc) return null;

  return (
    <div class="update-notice">
      {app && (
        <div class="update-notice-item">
          {app.installing ? (
            <span class="update-notice-text">
              Installing v{app.version}...
              {app.progress !== null && ` ${app.progress}%`}
            </span>
          ) : (
            <>
              <span class="update-notice-text">App v{app.version} available</span>
              <button class="btn btn-ghost update-notice-btn" onClick={handleAppInstall}>Update</button>
            </>
          )}
        </div>
      )}
      {sc && (
        <div class="update-notice-item">
          {sc.downloading ? (
            <span class="update-notice-text">
              Updating transcription engine...
              {sc.progress !== null && ` ${sc.progress}%`}
            </span>
          ) : (
            <>
              <span class="update-notice-text">Transcription engine v{sc.latest} available</span>
              <button class="btn btn-ghost update-notice-btn" onClick={handleSidecarUpdate}>Update</button>
            </>
          )}
        </div>
      )}
      {!app?.installing && !sc?.downloading && (
        <button class="btn btn-ghost update-notice-btn" onClick={() => { dismissed.value = true; }}>
          Later
        </button>
      )}
    </div>
  );
}
