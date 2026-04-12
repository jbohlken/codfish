import { useEffect, useRef } from "preact/hooks";
import { signal, useSignalEffect } from "@preact/signals";

// Module-scope: "there are paths waiting in Rust's LaunchPaths queue that
// haven't been drained yet." Set on boot and on every launch-paths-added
// event; the signal-effect inside App flips it off once it actually drains.
const launchPathsPending = signal(false);
import "./styles/components.css";
import { TitleBar } from "./components/layout/TitleBar";
import { ProjectPanel } from "./components/layout/ProjectPanel";
import { VideoPanel } from "./components/layout/VideoPanel";
import { CaptionPanel } from "./components/layout/CaptionPanel";
import { Timeline } from "./components/layout/Timeline";
import { isPlaying, undo, redo, isDirty, profiles, sidecarStatus, daemonStatus, project, projectPath, resetHistory } from "./store/app";
import { saveCurrentProject, saveCurrentProjectAs, newProjectGuarded, openProjectGuarded, closeProjectGuarded, openRecent } from "./lib/project";
import { loadProfiles } from "./lib/profiles";
import { recentProjects, loadRecent, clearRecent } from "./lib/recent";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { confirmUnsavedChanges } from "./components/UnsavedChanges";
import { ErrorModal } from "./components/ErrorModal";
import { ProfileManager, openProfileManager, requestCloseProfileManager } from "./components/ProfileManager";
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
import { FormatManager, openFormatManager, requestCloseFormatManager } from "./components/FormatManager";


export function App() {
  useUpdateChecker();
  useAutosaveRecovery();
  ensureGpuDetected();

  // On boot, check for a recovery snapshot and offer to restore it.
  // Gated on sidecar + daemon + profiles being ready so the prompt doesn't
  // queue up behind the Splash/SidecarSetup screens.
  const recoveryChecked = useRef(false);
  useEffect(() => {
    if (recoveryChecked.current) return;
    if (sidecarStatus.value !== "ready" && sidecarStatus.value !== "update_available") return;
    if (daemonStatus.value !== "ready") return;
    if (profiles.value.length === 0) return;
    recoveryChecked.current = true;
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
    loadRecent();
  }, []);

  // File association launch. Rust stashes .cod paths handed to us by the OS
  // (argv on Windows/Linux, RunEvent::Opened on macOS) into LaunchPaths, and
  // we drain them here once the app is actually ready to load a project.
  // Routing through openRecent gives us the fileExists check, unsaved-changes
  // gate, and add-to-recents hook for free.
  //
  // Correctness: a `launchPathsPending` signal + a signal-effect that also
  // reads the readiness signals means a drain scheduled while the app is
  // busy (e.g. Finder double-click mid-update on macOS) will automatically
  // re-fire when readiness flips, instead of being silently swallowed.
  // Pending is seeded true so the initial argv batch gets drained on boot.
  const drainingLaunchPaths = useRef(false);
  useEffect(() => {
    launchPathsPending.value = true;
    const unlisten = listen("launch-paths-added", () => {
      launchPathsPending.value = true;
    });
    return () => { unlisten.then((f) => f()); };
  }, []);
  useSignalEffect(() => {
    if (!launchPathsPending.value) return;
    const sidecarReady = sidecarStatus.value === "ready" || sidecarStatus.value === "update_available";
    if (!sidecarReady || daemonStatus.value !== "ready" || isUpdating()) return;
    if (drainingLaunchPaths.current) return;
    drainingLaunchPaths.current = true;
    launchPathsPending.value = false;
    (async () => {
      try {
        const paths = await invoke<string[]>("take_launch_paths");
        for (const p of paths) {
          await openRecent(p);
        }
      } catch (err) {
        console.error(err);
      } finally {
        drainingLaunchPaths.current = false;
      }
    })();
  });

  // Sync the OS window title to the current project + dirty state.
  // Format follows the Adobe convention: "Codfish - filename.cod *".
  // useSignalEffect (not useEffect) so we subscribe directly to signal reads
  // — App.tsx doesn't render project/isDirty, so a plain effect would never
  // re-fire on those changes. Deduped via lastTitle ref to avoid churning
  // IPC on per-keystroke dirty toggles.
  const lastTitle = useRef<string>("");
  useSignalEffect(() => {
    const proj = project.value;
    const path = projectPath.value;
    let title = "Codfish";
    if (proj) {
      const filename = path
        ? path.replace(/\\/g, "/").split("/").pop()
        : `${proj.name}.cod`;
      title = `Codfish - ${filename}${isDirty.value ? " *" : ""}`;
    }
    if (title !== lastTitle.current) {
      lastTitle.current = title;
      getCurrentWindow().setTitle(title).catch(() => {});
    }
  });

  // Push the recent-projects list into the native "Open Recent" submenu
  // whenever it changes. The Rust side stores a parallel path mapping so
  // on_menu_event can dispatch clicks back to the right file.
  useSignalEffect(() => {
    invoke("set_recent_menu", { entries: recentProjects.value }).catch(() => {});
  });

  // Push enabled-state for File menu items into the native menu whenever
  // the underlying signals change. useSignalEffect (not useEffect) so we
  // subscribe directly to signal reads — App doesn't render project/isDirty
  // in its body, so a plain effect would miss those changes.
  useSignalEffect(() => {
    const ready =
      (sidecarStatus.value === "ready" || sidecarStatus.value === "update_available") &&
      daemonStatus.value === "ready" &&
      !isUpdating();
    const hasProject = !!project.value;
    const dirty = isDirty.value;
    // Touch sidecarUpdate so we re-run when an update starts/finishes
    // downloading (isUpdating() reads it but the linter doesn't see that).
    void sidecarUpdate.value?.downloading;
    const set = (id: string, enabled: boolean) =>
      invoke("set_menu_enabled", { id, enabled }).catch(() => {});
    set("new_project", ready);
    set("open_project", ready);
    set("open_recent", ready);
    set("save_project_as", ready && hasProject);
    set("save_project", ready && hasProject && dirty);
    set("close_project", ready && hasProject);
  });

  useEffect(() => {
    const unlisten = listen<string>("menu://action", (e) => {
      // Block menu actions while splash/setup is up or an update is in
      // flight — otherwise file dialogs pop over the splash screen.
      if (isUpdating()) return;
      const sidecarReady = sidecarStatus.value === "ready" || sidecarStatus.value === "update_available";
      if (!sidecarReady || daemonStatus.value !== "ready") return;
      const hasProject = !!project.value;
      switch (e.payload) {
        case "new_project": newProjectGuarded(); break;
        case "open_project": openProjectGuarded(); break;
        case "save_project": if (hasProject && isDirty.value) saveCurrentProject(); break;
        case "save_project_as": if (hasProject) saveCurrentProjectAs(); break;
        case "close_project": if (hasProject) closeProjectGuarded(); break;
        case "clear_recent": clearRecent(); break;
        case "export_formats": requestCloseProfileManager().then((ok) => { if (ok) openFormatManager(); }); break;
        case "profiles": requestCloseFormatManager().then((ok) => { if (ok) openProfileManager(); }); break;
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  // Native menu → Open Recent click. Rust looks the path up by index and
  // emits this event with the path as payload. We route it through the same
  // unsaved-changes gate as the manual Open flow.
  useEffect(() => {
    const unlisten = listen<string>("menu://open-recent", (e) => {
      if (isUpdating()) return;
      const sidecarReady = sidecarStatus.value === "ready" || sidecarStatus.value === "update_available";
      if (!sidecarReady || daemonStatus.value !== "ready") return;
      openRecent(e.payload);
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
      // Windows-only fallback for File menu accelerators. WebView2 swallows
      // muda's accelerator table on Windows, so menu shortcuts never reach
      // the native handler. On macOS the system menu fires these natively
      // and we'd double-trigger if we also handled them here.
      const isMac = navigator.userAgent.toLowerCase().includes("mac");
      const ready =
        (sidecarStatus.value === "ready" || sidecarStatus.value === "update_available") &&
        daemonStatus.value === "ready" &&
        !isUpdating();
      const hasProject = !!project.value;
      if (!isMac && e.ctrlKey && ready) {
        const k = e.key.toLowerCase();
        if (k === "n") { e.preventDefault(); newProjectGuarded(); }
        else if (k === "o") { e.preventDefault(); openProjectGuarded(); }
        else if (k === "s" && e.shiftKey && hasProject) { e.preventDefault(); saveCurrentProjectAs(); }
        else if (k === "s" && hasProject && isDirty.value) { e.preventDefault(); saveCurrentProject(); }
        else if (k === "w" && hasProject) { e.preventDefault(); closeProjectGuarded(); }
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
        <ProfileManager />
        <ContextMenu />
        <MediaSettings />
        <FormatManager />
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
