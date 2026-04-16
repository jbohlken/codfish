import { useEffect, useRef } from "preact/hooks";
import { signal, useSignalEffect } from "@preact/signals";

// Module-scope: "there are paths waiting in Rust's LaunchPaths queue that
// haven't been drained yet." Set on boot and on every launch-paths-added
// event; the signal-effect inside App flips it off once it actually drains.
const launchPathsPending = signal(false);
// Flipped to true once the boot-time recovery check has fully resolved
// (no file found, or the user accepted/dismissed the prompt). Launch-path
// drain waits on this so a file-association open can't race the recovery
// prompt.
const recoveryDone = signal(false);
import "./styles/components.css";
import { TitleBar } from "./components/layout/TitleBar";
import { ProjectPanel } from "./components/layout/ProjectPanel";
import { VideoPanel } from "./components/layout/VideoPanel";
import { CaptionPanel, commitActiveEdit, cancelActiveEdit } from "./components/layout/CaptionPanel";
import { Timeline } from "./components/layout/Timeline";
import { isPlaying, undo, redo, canUndo, canRedo, undoDescription, redoDescription, isDirty, profiles, sidecarStatus, daemonStatus, project, projectPath, resetHistory } from "./store/app";
import { saveCurrentProject, saveCurrentProjectAs, newProjectGuarded, openProjectGuarded, closeProjectGuarded, revertProject, openRecent } from "./lib/project";
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
import { AboutModal, aboutOpen } from "./components/AboutModal";
import { Tooltip } from "./components/Tooltip";
import { SidecarSetup } from "./components/SidecarSetup";
import { Splash, startDaemon } from "./components/Splash";
import { daemonError } from "./store/app";
import { useUpdateChecker, sidecarUpdate, UpdateBlocker, isUpdating } from "./components/UpdateNotice";
import { BugReportModal, bugReportOpen } from "./components/BugReportModal";
import { useAutosaveRecovery, loadRecovery, clearRecovery } from "./lib/recovery";
import type { CodProject } from "./types/project";
import { RecoveryPrompt, askRestoreRecovery } from "./components/RecoveryPrompt";
import { FormatManager, openFormatManager, requestCloseFormatManager } from "./components/FormatManager";
import { theme, toggleTheme } from "./store/theme";


export function App() {
  useUpdateChecker();
  useAutosaveRecovery();
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
      if (cancelled || !blob) {
        recoveryDone.value = true;
        return;
      }
      const restore = await askRestoreRecovery(blob.saved_at);
      if (cancelled) return;
      if (restore) {
        try {
          const proj = JSON.parse(blob.json) as CodProject;
          resetHistory(proj);
          project.value = proj;
          projectPath.value = blob.original_path ?? null;
          isDirty.value = true;
        } catch (e) {
          console.error("recovery parse failed", e);
        }
      }
      await clearRecovery();
      recoveryDone.value = true;
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
    // Wait for the recovery prompt to resolve before draining launch paths,
    // otherwise a file-association open could race the restore decision.
    if (!recoveryDone.value) return;
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
    set("revert_project", ready && hasProject && !!projectPath.value && dirty);
    set("close_project", ready && hasProject);
    const undoEnabled = ready && hasProject && canUndo.value;
    const redoEnabled = ready && hasProject && canRedo.value;
    set("undo", undoEnabled);
    set("redo", redoEnabled);
    // Non-project-gated items: enabled whenever the app is fully ready so
    // the menu is uniformly inert during pre-splash and splash (Exit is the
    // only live escape hatch).
    set("export_formats", ready);
    set("profiles", ready);
    set("dark_mode", ready);
    set("about", ready);
    set("feedback", ready);
    const setText = (id: string, text: string) =>
      invoke("set_menu_text", { id, text }).catch(() => {});
    setText("undo", undoDescription.value ? `Undo ${undoDescription.value}` : "Undo");
    setText("redo", redoDescription.value ? `Redo ${redoDescription.value}` : "Redo");
  });

  // Sync the View → Dark Mode checkbox with the theme signal.
  useSignalEffect(() => {
    invoke("set_menu_checked", { id: "dark_mode", checked: theme.value === "dark" }).catch(() => {});
  });

  useEffect(() => {
    const unlisten = listen<string>("menu://action", (e) => {
      // Belt-and-suspenders: the menu's enabled state already blocks every
      // item except Exit during pre-splash, splash, and updates — but keep
      // a dispatcher-side gate so any residual event (e.g. a native menu
      // firing in a race window before set_menu_enabled lands) is still a
      // no-op.
      if (isUpdating()) return;
      const sidecarReady = sidecarStatus.value === "ready" || sidecarStatus.value === "update_available";
      if (!sidecarReady || daemonStatus.value !== "ready") return;
      // Forward-moving actions (save/new/open/close) commit in-flight edits so
      // the user's typed text is preserved. Backward-moving actions (undo/redo)
      // cancel them — committing would insert a history entry between the
      // action the menu label promised and the one actually performed.
      // Native menu clicks bypass the textarea's click-outside commit because
      // they don't produce a DOM mousedown.
      if (e.payload === "undo" || e.payload === "redo") {
        cancelActiveEdit();
      } else {
        commitActiveEdit();
      }
      const hasProject = !!project.value;
      switch (e.payload) {
        case "new_project": newProjectGuarded(); break;
        case "open_project": openProjectGuarded(); break;
        case "save_project": if (hasProject && isDirty.value) saveCurrentProject(); break;
        case "save_project_as": if (hasProject) saveCurrentProjectAs(); break;
        case "revert_project": if (hasProject && projectPath.value && isDirty.value) revertProject(); break;
        case "close_project": if (hasProject) closeProjectGuarded(); break;
        case "undo": if (hasProject) undo(); break;
        case "redo": if (hasProject) redo(); break;
        case "clear_recent": clearRecent(); break;
        case "export_formats": requestCloseProfileManager().then((ok) => { if (ok) openFormatManager(); }); break;
        case "profiles": requestCloseFormatManager().then((ok) => { if (ok) openProfileManager(); }); break;
        case "dark_mode": toggleTheme(); break;
        case "about": bugReportOpen.value = false; aboutOpen.value = true; break;
        case "feedback": aboutOpen.value = false; bugReportOpen.value = true; break;
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
      // Block browser/devtools shortcuts in release builds (F5 refresh, Ctrl+Shift+I, Ctrl+R, etc.)
      if (!import.meta.env.DEV && (
        e.key === "F5" ||
        (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "i") ||
        (e.metaKey && e.shiftKey && e.key.toLowerCase() === "i") ||
        (e.ctrlKey && e.key.toLowerCase() === "r") ||
        (e.metaKey && e.key.toLowerCase() === "r")
      )) {
        e.preventDefault();
        return;
      }
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
      // Windows-only fallback for menu accelerators. WebView2 swallows
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
        if (k === "z" && !e.shiftKey && hasProject) { e.preventDefault(); undo(); }
        else if ((k === "y" || (e.shiftKey && k === "z")) && hasProject) { e.preventDefault(); redo(); }
        else if (k === "n") { e.preventDefault(); newProjectGuarded(); }
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
        <AboutModal />
        <BugReportModal />
        <RecoveryPrompt />
        <Tooltip />
      </div>
      <UpdateBlocker />
    </>
  );
}
