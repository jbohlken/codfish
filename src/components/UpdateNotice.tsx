import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { updateChannel, isOsSupported, isBlockedUpdateDismissed, dismissBlockedUpdate, type AppUpdateMeta, type OsInfo } from "../lib/updates";
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
  flushOpenClipView,
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
  /** The channel this offer came from. Install uses THIS, not the live
   *  preference — so opting out of beta while an offer is shown can't fire a
   *  stable install that finds nothing. */
  beta: boolean;
  /** The release exists but the running OS is below its declared floor.
   *  We surface it as a note rather than an Update button; install is
   *  never reached. */
  blocked?: boolean;
  requiredOs?: string | null;
  /** Display name of the running OS ("macOS" / "Windows") for the blocked
   *  note — the floor is per-platform, so don't hardcode the label. */
  osLabel?: string;
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

// Monotonic token bumped whenever a check is (re)scheduled. A check involves
// two awaits (check_app_update, then get_os_version) so two can be in flight
// at once; each captures the token at entry and discards its result if a newer
// schedule superseded it — otherwise a slow check for a just-abandoned channel
// could resolve last and clobber the current offer (a persistent wrong-track
// offer). This is what actually enforces the "no wrong-track window" invariant.
let checkToken = 0;

function osDisplayName(os: string): string {
  if (os === "macos") return "macOS";
  if (os === "windows") return "Windows";
  return "your operating system";
}

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
  flushOpenClipView(); // remember the open clip's spot before tearing the project down
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

// Check the selected channel's endpoint and apply the OS-version gate: a
// release whose declared floor exceeds this machine's OS is shown as a note,
// never as an installable update. Sets appUpdate to null when up to date, so
// switching channels clears a stale offer. Never clobbers an in-flight install.
async function checkAppUpdate() {
  if (appUpdate.value?.installing) return;
  const token = checkToken;
  try {
    const beta = updateChannel.value === "beta";
    const meta = await invoke<AppUpdateMeta | null>("check_app_update", { beta });
    if (token !== checkToken) return; // superseded by a newer schedule (channel changed)
    if (!meta) { appUpdate.value = null; return; }
    const os = await invoke<OsInfo>("get_os_version");
    if (token !== checkToken) return;
    const supported = isOsSupported(os.version, meta.minimum_system_version);
    if (!supported) {
      // Below the floor: offer nothing installable. Show the note unless the
      // user already dismissed it for THIS version.
      appUpdate.value = isBlockedUpdateDismissed(meta.version)
        ? null
        : { version: meta.version, installing: false, progress: null, beta, blocked: true, requiredOs: meta.minimum_system_version, osLabel: osDisplayName(os.os) };
      return;
    }
    appUpdate.value = { version: meta.version, installing: false, progress: null, beta };
  } catch {}
}

/** Hook that sets up update checking — call once at app root */
export function useUpdateChecker() {
  // ONE pending-check timer, rescheduled by every trigger so they can never
  // race. The launch check (5s startup-settle) and each channel toggle share
  // it: flip the toggle partway through the 5s window and the launch timer is
  // cancelled and replaced by the toggle's shorter debounce — never both fire.
  // On a toggle we also drop any current offer immediately, so a just-
  // abandoned channel can't leave a wrong-track offer clickable during the
  // re-check. Rapid flips collapse to a single network call.
  const checkTimer = useRef<number | undefined>(undefined);
  const launched = useRef(false);
  useEffect(() => {
    const isLaunch = !launched.current;
    launched.current = true;
    // Bump the token so any check already in flight for the previous channel
    // discards its result instead of clobbering the offer we're about to set.
    checkToken++;
    if (!isLaunch && !appUpdate.value?.installing) appUpdate.value = null;
    window.clearTimeout(checkTimer.current);
    checkTimer.current = window.setTimeout(() => { void checkAppUpdate(); }, isLaunch ? 5000 : 600);
    return () => window.clearTimeout(checkTimer.current);
  }, [updateChannel.value]);

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
  if (!state || state.blocked) return;
  if (!(await gateForUpdate("app"))) return;
  popoverOpen.value = false;
  appUpdate.value = { ...state, installing: true, progress: 0 };

  // Use the channel the offer came from, not the live preference.
  const beta = state.beta;
  // Rust drives download+install (endpoint chosen by channel) and emits
  // progress; percent is null when the manifest gives no content length.
  const unlisten = await listen<{ downloaded: number; total: number | null }>(
    "app-update://progress",
    (e) => {
      const { downloaded, total } = e.payload;
      const percent = total && total > 0 ? Math.round((downloaded / total) * 100) : null;
      const s = appUpdate.value;
      if (s?.installing) appUpdate.value = { ...s, progress: percent };
    },
  );

  try {
    await invoke("install_app_update", { beta });
    await clearRecovery();
    await relaunch();
  } catch (e) {
    const msg = typeof e === "string" ? e : (e as any)?.message ?? String(e);
    appUpdate.value = { ...state, installing: false, progress: null };
    showError(`App update failed: ${msg}`);
  } finally {
    unlisten();
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
          {app.blocked ? (
            <div class="update-popover-blocked">
              <span class="update-popover-note">Requires {app.osLabel ?? "macOS"} {app.requiredOs}</span>
              <button
                class="btn btn-ghost btn-sm"
                onClick={() => {
                  dismissBlockedUpdate(app.version);
                  appUpdate.value = null;
                  popoverOpen.value = false;
                }}
              >Dismiss</button>
            </div>
          ) : (
            <button class="btn btn-primary btn-sm" onClick={handleAppInstall}>Update</button>
          )}
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
