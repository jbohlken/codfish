import { useEffect } from "preact/hooks";
import "./styles/components.css";
import { TitleBar } from "./components/layout/TitleBar";
import { ProjectPanel } from "./components/layout/ProjectPanel";
import { VideoPanel } from "./components/layout/VideoPanel";
import { CaptionPanel } from "./components/layout/CaptionPanel";
import { Timeline } from "./components/layout/Timeline";
import { isPlaying, undo, redo, isDirty, profiles, sidecarStatus, daemonStatus, project, projectPath, resetHistory } from "./store/app";
import { saveCurrentProject, loadProjectFromPath } from "./lib/project";
import { loadProfiles } from "./lib/profiles";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { confirmUnsavedChanges } from "./components/UnsavedChanges";
import { ErrorModal } from "./components/ErrorModal";
import { ProfileEditor } from "./components/ProfileEditor";
import { ContextMenu } from "./components/ContextMenu";
import { MediaSettings } from "./components/MediaSettings";
import { UnsavedChanges } from "./components/UnsavedChanges";
import { HelpModal } from "./components/HelpModal";
import { Tooltip } from "./components/Tooltip";
import { SidecarSetup } from "./components/SidecarSetup";
import { Splash, startDaemon } from "./components/Splash";
import { daemonError } from "./store/app";
import { useUpdateChecker, sidecarUpdate, UpdateBlocker, isUpdating } from "./components/UpdateNotice";
import { BugReportModal } from "./components/BugReportModal";
import { useAutosaveRecovery, loadRecovery, clearRecovery } from "./lib/recovery";
import { ensureGpuDetected } from "./lib/gpu";
import type { CodProject } from "./types/project";
import { RecoveryPrompt, askRestoreRecovery } from "./components/RecoveryPrompt";

export function App() {
  useUpdateChecker();
  useAutosaveRecovery();
  ensureGpuDetected();

  // On boot, check for a recovery snapshot and offer to restore it.
  // Gated on sidecar + daemon + profiles being ready so the prompt doesn't
  // queue up behind the Splash/SidecarSetup screens.
  useEffect(() => {
    if (sidecarStatus.value !== "ready" && sidecarStatus.value !== "update_available") return;
    if (daemonStatus.value !== "ready") return;
    if (profiles.value.length === 0) return;
    let cancelled = false;
    (async () => {
      const blob = await loadRecovery();
      if (cancelled || !blob) return;
      const restore = await askRestoreRecovery(blob.saved_at);
      if (cancelled) return;
      if (restore) {
        try {
          const proj = JSON.parse(blob.json) as CodProject;
          resetHistory(proj);
          project.value = proj;
          projectPath.value = blob.original_path ?? null;
          // Mark dirty so the user is prompted to save — the recovery
          // file represents unsaved work, and on-disk is still stale.
          isDirty.value = true;
        } catch (e) {
          console.error("recovery parse failed", e);
        }
      }
      await clearRecovery();
    })();
    return () => { cancelled = true; };
  }, [sidecarStatus.value, daemonStatus.value, profiles.value.length]);

  useEffect(() => {
    const win = getCurrentWindow();

    // Shared exit gate. Returns true if the caller should proceed with
    // tearing down (window destroy or app exit), false to abort.
    const runExitGate = async (): Promise<boolean> => {
      if (isUpdating()) return false;
      if (isDirty.value) {
        const choice = await confirmUnsavedChanges();
        if (choice === "cancel") return false;
        if (choice === "save") {
          const saved = await saveCurrentProject();
          if (!saved) return false;
        }
      }
      await clearRecovery();
      return true;
    };

    const unlistenClose = win.onCloseRequested(async (e) => {
      e.preventDefault();
      if (await runExitGate()) await win.destroy();
    });

    // Cmd+Q / app menu Quit on macOS routes through here. The Rust side
    // intercepts ExitRequested, prevents exit, and emits this event so we
    // can run the same gate before calling force_quit.
    const unlistenQuit = listen("app://quit-requested", async () => {
      if (await runExitGate()) await invoke("force_quit");
    });

    return () => {
      unlistenClose.then((f) => f());
      unlistenQuit.then((f) => f());
    };
  }, []);

  useEffect(() => {
    invoke("get_sidecar_status").then((status: any) => {
      if (status.status === "ready") {
        sidecarStatus.value = "ready";
        // Check for sidecar updates in the background
        invoke("check_sidecar_update").then((result: any) => {
          if (result.status === "update_available") {
            sidecarStatus.value = "update_available";
          }
        }).catch(() => {});
      } else {
        sidecarStatus.value = "not_installed";
      }
    }).catch(() => {
      sidecarStatus.value = "not_installed";
    });
  }, []);

  // Persistent daemon status listener — must outlive the Splash component
  // so mid-session crashes flip the UI back to the splash.
  useEffect(() => {
    const unlisten = listen<{ state: string; device?: string; reason?: string }>(
      "daemon://status",
      (e) => {
        const s = e.payload;
        if (s.state === "ready") {
          daemonStatus.value = "ready";
          daemonError.value = null;
        } else if (s.state === "booting") {
          daemonStatus.value = "booting";
        } else if (s.state === "crashed") {
          daemonStatus.value = "crashed";
          daemonError.value = s.reason ?? "Transcription engine crashed";
        } else if (s.state === "not_installed") {
          daemonStatus.value = "not_installed";
        }
      },
    );
    return () => { unlisten.then((f) => f()); };
  }, []);

  // Kick off the daemon once the sidecar is confirmed installed.
  useEffect(() => {
    if (
      (sidecarStatus.value === "ready" || sidecarStatus.value === "update_available") &&
      daemonStatus.value === "checking"
    ) {
      startDaemon();
    }
  }, [sidecarStatus.value, daemonStatus.value]);

  useEffect(() => {
    loadProfiles().then((p) => { profiles.value = p; });
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("open-file", (e) => {
      loadProjectFromPath(e.payload).catch(console.error);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Swallow everything while an update is in flight — the blocker is up
      // and there's no project state left to act on.
      if (isUpdating()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Don't intercept shortcuts while editing text
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) return;

      if (e.code === "Space") {
        e.preventDefault();
        isPlaying.value = !isPlaying.peek();
      }
      if (e.ctrlKey && !e.shiftKey && e.key === "z") {
        e.preventDefault();
        undo();
      }
      if (e.ctrlKey && (e.key === "y" || (e.shiftKey && e.key === "Z"))) {
        e.preventDefault();
        redo();
      }
      if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        saveCurrentProject();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  if (sidecarStatus.value === "checking") return null;
  if (sidecarStatus.value !== "ready" && sidecarStatus.value !== "update_available") {
    return <SidecarSetup />;
  }
  // While a sidecar update is actively downloading, keep the main shell up
  // so the update popover stays visible. The daemon is intentionally dead
  // during this window; showing the crash splash would hide the progress UI.
  if (daemonStatus.value !== "ready" && !sidecarUpdate.value?.downloading) {
    return <Splash />;
  }
  if (profiles.value.length === 0) return null;

  return (
    <>
      <div class="app-shell" {...(isUpdating() ? { inert: true } : {})}>
        <TitleBar />
        <div class="main-panels">
          <ProjectPanel />
          <VideoPanel />
          <CaptionPanel />
        </div>
        <Timeline />
        <ErrorModal />
        <ProfileEditor />
        <ContextMenu />
        <MediaSettings />
        <UnsavedChanges />
        <HelpModal />
        <BugReportModal />
        <RecoveryPrompt />
        <Tooltip />
      </div>
      <UpdateBlocker />
    </>
  );
}
