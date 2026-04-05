import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sidecarStatus } from "../store/app";

interface GpuInfo {
  hasCuda: boolean;
  gpuName: string | null;
  vramMb: number | null;
}

interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
}

const gpu = signal<GpuInfo | null>(null);
const gpuChecking = signal(true);
const selectedVariant = signal<"cpu" | "cuda">("cpu");
const downloading = signal(false);
const progress = signal<DownloadProgress | null>(null);
const error = signal<string | null>(null);

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

export function SidecarSetup() {
  useEffect(() => {
    invoke<GpuInfo>("detect_gpu").then((info) => {
      gpu.value = info;
      gpuChecking.value = false;
      if (info.hasCuda) {
        selectedVariant.value = "cuda";
      }
    }).catch(() => {
      gpuChecking.value = false;
    });
  }, []);

  useEffect(() => {
    const unlisten = listen<DownloadProgress>("sidecar://download-progress", (e) => {
      progress.value = e.payload;
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  const handleDownload = async () => {
    error.value = null;
    downloading.value = true;
    progress.value = null;
    sidecarStatus.value = "downloading";

    try {
      await invoke("download_sidecar", { variant: selectedVariant.value });
      sidecarStatus.value = "ready";
    } catch (e) {
      error.value = String(e);
      downloading.value = false;
      sidecarStatus.value = "not_installed";
    }
  };

  const gpuInfo = gpu.value;
  const prog = progress.value;
  const isDownloading = downloading.value;

  return (
    <div class="sidecar-setup">
      <div class="sidecar-setup-card">
        <h1 class="sidecar-setup-title">Codfish</h1>
        <p class="sidecar-setup-subtitle">
          Caption generation and editing for media producers
        </p>

        <div class="sidecar-setup-section">
          <h2 class="sidecar-setup-heading">Transcription Engine</h2>
          <p class="sidecar-setup-text">
            Codfish needs to download its transcription engine before you can
            generate captions. This is a one-time download.
          </p>
        </div>

        {/* GPU Detection */}
        <div class="sidecar-setup-section">
          <h3 class="sidecar-setup-label">GPU Detection</h3>
          {gpuChecking.value ? (
            <p class="sidecar-setup-text sidecar-setup-text--secondary">
              Checking for NVIDIA GPU...
            </p>
          ) : gpuInfo?.hasCuda ? (
            <p class="sidecar-setup-text sidecar-setup-text--success">
              {gpuInfo.gpuName}
              {gpuInfo.vramMb ? ` (${(gpuInfo.vramMb / 1024).toFixed(0)} GB VRAM)` : ""}
              {" "} — CUDA acceleration available
            </p>
          ) : (
            <p class="sidecar-setup-text sidecar-setup-text--secondary">
              No NVIDIA GPU detected. CPU mode will be used.
            </p>
          )}
        </div>

        {/* Variant Picker */}
        {!isDownloading && gpuInfo?.hasCuda && (
          <div class="sidecar-setup-section">
            <h3 class="sidecar-setup-label">Version</h3>
            <div class="sidecar-setup-variants">
              <label class={`sidecar-variant ${selectedVariant.value === "cuda" ? "sidecar-variant--selected" : ""}`}>
                <input
                  type="radio"
                  name="variant"
                  value="cuda"
                  checked={selectedVariant.value === "cuda"}
                  onChange={() => { selectedVariant.value = "cuda"; }}
                />
                <div>
                  <strong>CUDA (Recommended)</strong>
                  <span>GPU-accelerated — much faster transcription</span>
                </div>
              </label>
              <label class={`sidecar-variant ${selectedVariant.value === "cpu" ? "sidecar-variant--selected" : ""}`}>
                <input
                  type="radio"
                  name="variant"
                  value="cpu"
                  checked={selectedVariant.value === "cpu"}
                  onChange={() => { selectedVariant.value = "cpu"; }}
                />
                <div>
                  <strong>CPU</strong>
                  <span>No GPU required — slower but works everywhere</span>
                </div>
              </label>
            </div>
          </div>
        )}

        {/* Download / Progress */}
        <div class="sidecar-setup-section">
          {isDownloading ? (
            <div class="sidecar-setup-progress">
              <div class="sidecar-setup-progress-header">
                <span>Downloading transcription engine...</span>
                <span>
                  {prog ? `${formatBytes(prog.downloadedBytes)} / ${formatBytes(prog.totalBytes)}` : "Starting..."}
                </span>
              </div>
              <div class="progress-bar-track">
                <div
                  class="progress-bar-fill"
                  style={{ width: `${prog?.percent ?? 0}%` }}
                />
              </div>
              <p class="sidecar-setup-text sidecar-setup-text--secondary">
                This may take a few minutes depending on your connection.
              </p>
            </div>
          ) : (
            <button
              class="btn btn-primary sidecar-setup-download"
              onClick={handleDownload}
              disabled={gpuChecking.value}
            >
              Download {gpuInfo?.hasCuda ? (selectedVariant.value === "cuda" ? "CUDA" : "CPU") : "CPU"} Engine
            </button>
          )}
        </div>

        {error.value && (
          <div class="sidecar-setup-error">
            <strong>Download failed:</strong> {error.value}
            <button class="btn btn-ghost" onClick={() => { error.value = null; }}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
