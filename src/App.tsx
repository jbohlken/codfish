import { useEffect } from "preact/hooks";
import "./styles/components.css";
import { TitleBar } from "./components/layout/TitleBar";
import { ProjectPanel } from "./components/layout/ProjectPanel";
import { VideoPanel } from "./components/layout/VideoPanel";
import { CaptionPanel } from "./components/layout/CaptionPanel";
import { Timeline } from "./components/layout/Timeline";
import { isPlaying, undo, redo, isDirty, profiles, sidecarStatus } from "./store/app";
import { saveCurrentProject } from "./lib/project";
import { loadProfiles } from "./lib/profiles";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirmUnsavedChanges } from "./components/UnsavedChanges";
import { ErrorModal } from "./components/ErrorModal";
import { ProfileEditor } from "./components/ProfileEditor";
import { ContextMenu } from "./components/ContextMenu";
import { MediaSettings } from "./components/MediaSettings";
import { UnsavedChanges } from "./components/UnsavedChanges";
import { HelpModal } from "./components/HelpModal";
import { Tooltip } from "./components/Tooltip";
import { SidecarSetup } from "./components/SidecarSetup";
import { UpdateNotice } from "./components/UpdateNotice";

export function App() {
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested(async (e) => {
      e.preventDefault();
      if (isDirty.value) {
        const choice = await confirmUnsavedChanges();
        if (choice === "cancel") return;
        if (choice === "save") {
          await saveCurrentProject();
        }
      }
      await win.destroy();
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    invoke("get_sidecar_status").then((status: any) => {
      sidecarStatus.value = status.status === "ready" ? "ready" : "not_installed";
    }).catch(() => {
      sidecarStatus.value = "not_installed";
    });
  }, []);

  useEffect(() => {
    loadProfiles().then((p) => { profiles.value = p; });
  }, []);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
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
  if (profiles.value.length === 0) return null;

  return (
    <div class="app-shell">
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
      <Tooltip />
      <UpdateNotice />
    </div>
  );
}
