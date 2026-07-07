import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { XIcon as X, FolderOpenIcon as FolderOpen } from "@phosphor-icons/react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { project, pushHistory } from "../store/app";
import { isDropFrameRate } from "../lib/time";
import { useEscapeToClose } from "../lib/useEscapeToClose";
import { useBackdropClose } from "../lib/useBackdropClose";

export const mediaSettingsId = signal<string | null>(null);

export function MediaSettings() {
  const id = mediaSettingsId.value;
  const proj = project.value;
  const item = id && proj ? proj.media.find((m) => m.id === id) : undefined;
  // Keyed on the RESOLVED item, not the id: the id outlives the project
  // (closing the project with this dialog open never cleared it), and a
  // phantom stack entry would swallow the next Escape and keep undo/redo
  // grayed in the next project.
  useEscapeToClose(!!item, () => { mediaSettingsId.value = null; });
  const backdropProps = useBackdropClose(() => { mediaSettingsId.value = null; });
  // Drop a stale id once it stops resolving so it can't ghost-reopen.
  useEffect(() => {
    if (id && !item) mediaSettingsId.value = null;
  }, [id, item]);
  if (!id || !proj || !item) return null;

  const canDropFrame = item.fps != null && isDropFrameRate(item.fps);

  const close = () => { mediaSettingsId.value = null; };

  const toggleDropFrame = () => {
    pushHistory({
      ...proj,
      media: proj.media.map((m) =>
        m.id !== id ? m : { ...m, dropFrame: !m.dropFrame }
      ),
    }, item.dropFrame ? "Switch to NDF" : "Switch to DF");
  };

  return (
    <div class="modal-backdrop" {...backdropProps}>
      <div class="media-settings" onClick={(e) => e.stopPropagation()}>
        <div class="media-settings-header">
          <span class="media-settings-title">{item.name}</span>
          <button class="btn btn-ghost btn-icon" onClick={close}><X size={14} /></button>
        </div>

        <div class="media-settings-body">
          <div class="ms-row">
            <label class="ms-label">Path</label>
            <span class="ms-path">{item.path}</span>
            <button
              class="btn btn-ghost btn-icon"
              data-tooltip="Open file location"
              onClick={async () => {
                try { await revealItemInDir(item.path); }
                catch (e) { console.error("reveal failed", e); }
              }}
            >
              <FolderOpen size={14} />
            </button>
          </div>
          <div class="ms-row">
            <label class="ms-label">Frame rate</label>
            <span class="ms-value">
              {item.fps != null ? `${item.fps} fps (detected)` : "None"}
            </span>
          </div>
          {canDropFrame && (
            <div class="ms-row">
              <label class="ms-label">Timecode</label>
              <button class="btn btn-secondary btn-sm" onClick={toggleDropFrame}>
                {item.dropFrame ? "Drop-Frame" : "Non-Drop-Frame"}
              </button>
            </div>
          )}
        </div>

        <div class="media-settings-footer">
          <button class="btn btn-primary" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}
