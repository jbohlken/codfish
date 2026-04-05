import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

interface UpdateState {
  version: string;
  installing: boolean;
  progress: number | null;
}

const update = signal<UpdateState | null>(null);
const dismissed = signal(false);

export function UpdateNotice() {
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const available = await check();
        if (available) {
          update.value = {
            version: available.version,
            installing: false,
            progress: null,
          };
        }
      } catch {
        // Silently ignore — update check is best-effort
      }
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  const state = update.value;
  if (!state || dismissed.value) return null;

  const handleInstall = async () => {
    update.value = { ...state, installing: true, progress: 0 };
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
          update.value = { ...state, installing: true, progress: percent };
        } else if (event.event === "Finished") {
          update.value = { ...state, installing: true, progress: 100 };
        }
      });

      await relaunch();
    } catch {
      update.value = { ...state, installing: false, progress: null };
    }
  };

  return (
    <div class="update-notice">
      {state.installing ? (
        <span class="update-notice-text">
          Installing v{state.version}...
          {state.progress !== null && ` ${state.progress}%`}
        </span>
      ) : (
        <>
          <span class="update-notice-text">
            v{state.version} available
          </span>
          <button class="btn btn-ghost update-notice-btn" onClick={handleInstall}>
            Update
          </button>
          <button class="btn btn-ghost update-notice-btn" onClick={() => { dismissed.value = true; }}>
            Later
          </button>
        </>
      )}
    </div>
  );
}
