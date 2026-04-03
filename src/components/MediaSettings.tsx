import { signal } from "@preact/signals";
import { project } from "../store/app";

export const mediaSettingsId = signal<string | null>(null);

export function MediaSettings() {
  const id = mediaSettingsId.value;
  const proj = project.value;
  if (!id || !proj) return null;

  const item = proj.media.find((m) => m.id === id);
  if (!item) return null;

  const close = () => { mediaSettingsId.value = null; };

  return (
    <div class="modal-backdrop" onClick={close}>
      <div class="media-settings" onClick={(e) => e.stopPropagation()}>
        <div class="media-settings-header">
          <span class="media-settings-title">{item.name}</span>
          <button class="btn btn-ghost btn-icon" onClick={close}>✕</button>
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
        </div>

        <div class="media-settings-footer">
          <button class="btn btn-primary" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}
