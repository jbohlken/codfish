import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { getVersion } from "@tauri-apps/api/app";

export const helpOpen = signal(false);

const SHORTCUTS = [
  { group: "Playback" },
  { key: "Space",          desc: "Play / Pause" },
  { group: "Captions" },
  { key: "A",              desc: "Add caption at playhead" },
  { key: "E",              desc: "Edit selected caption" },
  { key: "S",              desc: "Split selected caption at playhead" },
  { key: "Delete",         desc: "Delete selected caption" },
  { key: "Escape",         desc: "Deselect caption / cancel edit" },
  { group: "History" },
  { key: "Ctrl+Z",         desc: "Undo" },
  { key: "Ctrl+Y",         desc: "Redo" },
  { group: "Project" },
  { key: "Ctrl+S",         desc: "Save" },
];

export function HelpModal() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  if (!helpOpen.value) return null;

  const close = () => { helpOpen.value = false; };

  return (
    <div class="modal-backdrop" onClick={close}>
      <div class="help-modal" onClick={(e) => e.stopPropagation()}>
        <div class="help-modal-header">
          <span class="help-modal-title">Help</span>
          <button class="btn btn-ghost btn-icon" onClick={close}>✕</button>
        </div>

        <div class="help-modal-body">
          <section class="help-section">
            <h3 class="help-section-title">Keyboard Shortcuts</h3>
            <table class="help-shortcuts">
              <tbody>
                {SHORTCUTS.map((row, i) =>
                  "group" in row ? (
                    <tr key={i} class="help-shortcut-group">
                      <td colspan={2}>{row.group}</td>
                    </tr>
                  ) : (
                    <tr key={i} class="help-shortcut-row">
                      <td class="help-shortcut-key"><kbd>{row.key}</kbd></td>
                      <td class="help-shortcut-desc">{row.desc}</td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </section>

          <section class="help-section">
            <h3 class="help-section-title">About</h3>
            <p class="help-about-name">Codfish{version && <span class="help-about-version">v{version}</span>}</p>
            <p class="help-about-desc">Caption editor for video and audio files.</p>
            <p class="help-about-desc">Made by Jared Bohlken.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
