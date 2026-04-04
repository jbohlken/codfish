export interface Word {
  text: string;
  start: number;      // seconds
  end: number;        // seconds
  confidence: number; // 0–1
  speaker?: string;
}

export interface CaptionBlock {
  index: number;
  start: number;    // seconds
  end: number;      // seconds
  lines: string[];
  speaker?: string;
  words?: Word[];   // populated during pipeline, not persisted to .cod file
}

export interface ExportRecord {
  format: "srt" | "vtt";
  path: string;
  exportedAt: string;
}

export interface MediaItem {
  id: string;
  name: string;
  path: string;
  fps: number | null;  // probed from file; null = audio-only or unknown (use profile default)
  captions: CaptionBlock[];
  rawWords?: Word[];              // persisted for future re-pipeline without re-transcribing
  generatedAt?: string;
  generatedWithModel?: TranscriptionModel;
  generatedWithLanguage?: string; // the user's selection; absent means auto-detect was used
  detectedLanguage?: string;      // set when auto-detect was used
  exports: ExportRecord[];
}

export type TranscriptionModel = "tiny" | "base" | "small" | "medium" | "large-v3";

export interface CodProject {
  version: number;
  name: string;
  profileId: string;
  transcriptionModel: TranscriptionModel;
  language: string;
  exportFormatId?: string;
  createdAt: string;
  updatedAt: string;
  media: MediaItem[];
}
