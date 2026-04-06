import { signal } from "@preact/signals";
import { invoke } from "@tauri-apps/api/core";

export interface GpuInfo {
  hasCuda: boolean;
  gpuName: string | null;
  vramMb: number | null;
}

/** Cached GPU detection. Populated once at app boot — `null` until then. */
export const gpuInfo = signal<GpuInfo | null>(null);

let _detectStarted = false;
/** Kick off detection once. Safe to call repeatedly; subsequent calls no-op. */
export function ensureGpuDetected(): void {
  if (_detectStarted) return;
  _detectStarted = true;
  invoke<GpuInfo>("detect_gpu")
    .then((info) => { gpuInfo.value = info; })
    .catch(() => { gpuInfo.value = { hasCuda: false, gpuName: null, vramMb: null }; });
}
