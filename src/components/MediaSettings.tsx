import { signal } from "@preact/signals";
import { XIcon as X } from "@phosphor-icons/react";
import { project, pushHistory } from "../store/app";
import { isDropFrameRate } from "../lib/time";

export const mediaSettingsId = signal<string | null>(null);

export function MediaSettings() {
  const id = mediaSettingsId.value;
  const proj = project.value;
  if (!id || !proj) return null;

  const item = proj.media.find((m) => m.id === id);
  if (!item) return null;

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
    <div class="modal-backdrop" onClick={close}>
      <div class="media-settings" onClick={(e) => e.stopPropagation()}>
        <div class="media-settings-header">
          <span class="media-settings-title">{item.name}</span>
          <button class="btn btn-ghost btn-icon" onClick={close}><X size={14} /></button>
        </div>

        <div class="media-settings-body">
          <div class="ms-row">
            <label class="ms-label">Path</label>
            <span class="ms-path">{item.path}</span>
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
