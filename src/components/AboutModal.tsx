import { signal } from "@preact/signals";
import { XIcon as X, FolderOpenIcon as FolderOpen } from "@phosphor-icons/react";
import { useEffect, useState } from "preact/hooks";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";

export const aboutOpen = signal(false);

export function AboutModal() {
  const [version, setVersion] = useState<string | null>(null);
  const [sidecarVersion, setSidecarVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!aboutOpen.value) return;
    getVersion().then(setVersion).catch(() => {});
    invoke<{ status: string; version?: string; variant?: string }>("get_sidecar_status")
      .then((s) => {
        if (s.version && s.variant) {
          setSidecarVersion(`v${s.version} (${s.variant})`);
        } else if (s.status === "not_installed") {
          setSidecarVersion("not installed");
        }
      })
      .catch(() => {});
  }, [aboutOpen.value]);

  if (!aboutOpen.value) return null;

  const close = () => { aboutOpen.value = false; };

  return (
    <div class="modal-backdrop" onClick={close}>
      <div class="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div class="modal-panel-header">
          <span class="modal-panel-title">About Codfish</span>
          <button class="btn btn-ghost btn-icon" onClick={close}><X size={14} /></button>
        </div>

        <div class="modal-panel-body">
          <section class="about-section">
            <p class="about-name"><img src="/icon.png" alt="" class="about-icon" />Codfish{version && <span class="about-version">v{version}</span>}</p>
            <p class="about-desc">Caption generation and editing that respects your standards, privacy, and time.</p>
            <p class="about-desc">
              &copy; {new Date().getFullYear()} Jared Bohlken. Licensed under the{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); openUrl("https://www.apache.org/licenses/LICENSE-2.0"); }}>Apache License 2.0</a>.
            </p>
          </section>

          {sidecarVersion && (
            <section class="about-section">
              <h3 class="about-section-title">Transcription Engine</h3>
              <p class="about-desc">{sidecarVersion}</p>
            </section>
          )}

          <section class="about-section">
            <h3 class="about-section-title">Diagnostics</h3>
            <p class="about-desc">
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
                <FolderOpen size={13} /> Open log file
              </button>
            </p>
          </section>

          <section class="about-section">
            <h3 class="about-section-title">Acknowledgements</h3>
            <p class="about-desc">
              Bundles <a href="#" onClick={(e) => { e.preventDefault(); openUrl("https://vercel.com/font"); }}>Geist Sans and Geist Mono</a>,
              {" "}Copyright 2024 The Geist Project Authors,
              {" "}licensed under the{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); openUrl("https://openfontlicense.org"); }}>SIL Open Font License 1.1</a>.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
