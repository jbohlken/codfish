import { signal } from "@preact/signals";
import { XIcon as X } from "@phosphor-icons/react";
import { useEffect, useState } from "preact/hooks";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { switchSidecarVariant } from "./UpdateNotice";
import { gpuInfo, ensureGpuDetected } from "../lib/gpu";

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
  const [sidecarVersion, setSidecarVersion] = useState<string | null>(null);
  const [sidecarVariant, setSidecarVariant] = useState<string | null>(null);

  useEffect(() => {
    if (!helpOpen.value) return;
    ensureGpuDetected();
    getVersion().then(setVersion).catch(() => {});
    invoke<{ status: string; version?: string; variant?: string }>("get_sidecar_status")
      .then((s) => {
        if (s.version && s.variant) {
          setSidecarVersion(`v${s.version} (${s.variant})`);
          setSidecarVariant(s.variant);
        } else if (s.status === "not_installed") {
          setSidecarVersion("not installed");
        }
      })
      .catch(() => {});
  }, [helpOpen.value]);

  const gpu = gpuInfo.value;
  const otherVariant: "cpu" | "cuda" | null =
    sidecarVariant === "cuda" ? "cpu"
    : sidecarVariant === "cpu" && gpu?.hasCuda ? "cuda"
    : null;

  const handleSwitch = async () => {
    if (!otherVariant) return;
    helpOpen.value = false;
    await switchSidecarVariant(otherVariant);
  };

  if (!helpOpen.value) return null;

  const close = () => { helpOpen.value = false; };

  return (
    <div class="modal-backdrop" onClick={close}>
      <div class="help-modal" onClick={(e) => e.stopPropagation()}>
        <div class="help-modal-header">
          <span class="help-modal-title">Help</span>
          <button class="btn btn-ghost btn-icon" onClick={close}><X size={14} /></button>
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
            <h3 class="help-section-title">Diagnostics</h3>
            <p class="help-about-desc">
              <button
                class="btn btn-ghost btn-sm"
                onClick={async () => {
                  try {
                    const path = await invoke<string>("get_log_path");
                    await revealItemInDir(path);
                  } catch (e) {
                    console.error("open log failed", e);
                  }
                }}
              >
                Open log file
              </button>
            </p>
          </section>

          <section class="help-section">
            <h3 class="help-section-title">About</h3>
            <p class="help-about-name">Codfish{version && <span class="help-about-version">v{version}</span>}</p>
            {sidecarVersion && (
              <p class="help-about-desc">
                Transcription engine: {sidecarVersion}
                {otherVariant && (
                  <>
                    {" — "}
                    <button class="btn btn-ghost btn-sm" onClick={handleSwitch}>
                      Switch to {otherVariant.toUpperCase()}
                    </button>
                  </>
                )}
              </p>
            )}
            <p class="help-about-desc">Caption editor for video and audio files.</p>
            <p class="help-about-desc">Made by Jared Bohlken.</p>
          </section>

          <section class="help-section">
            <h3 class="help-section-title">Acknowledgements</h3>
            <p class="help-about-desc">
              Bundles <a href="https://vercel.com/font" target="_blank" rel="noreferrer">Geist Sans and Geist Mono</a>,
              {" "}Copyright 2024 The Geist Project Authors,
              {" "}licensed under the{" "}
              <a href="https://openfontlicense.org" target="_blank" rel="noreferrer">SIL Open Font License 1.1</a>.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
