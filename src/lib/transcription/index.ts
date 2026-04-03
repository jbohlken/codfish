import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Word } from "../../types/project";

// ── Types mirroring Rust structs ─────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  sizeMb: number;
  cached: boolean;
}

export interface TranscriptionProgress {
  stage: "downloading" | "loading_model" | "transcribing" | "done";
  percent: number;
  message: string;
}

// ── Commands ─────────────────────────────────────────────────────────────────

export async function listModels(): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("list_models");
}

/**
 * Transcribe a media file.
 * Runs the full pipeline: extract audio → mel → encode → decode.
 * Returns a Word[] ready to pass into runPipeline().
 */
export async function transcribeMedia(
  mediaPath: string,
  modelId: string,
  language: string | null,
  onProgress?: (p: TranscriptionProgress) => void,
): Promise<Word[]> {
  let unlisten: UnlistenFn | null = null;

  if (onProgress) {
    unlisten = await listen<TranscriptionProgress>(
      "transcription://progress",
      (e) => onProgress(e.payload),
    );
  }

  try {
    const raw = await invoke<Array<{
      text: string;
      start: number;
      end: number;
      confidence: number;
      speaker: string | null;
    }>>("transcribe_media", { mediaPath, modelId, language });

    return raw.map((w) => ({
      text: w.text,
      start: w.start,
      end: w.end,
      confidence: w.confidence,
      speaker: w.speaker ?? undefined,
    }));
  } finally {
    unlisten?.();
  }
}
