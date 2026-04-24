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
  /// True when the caption's text was manually edited or the caption was
  /// manually added. Split/merge fall back to text-only operations on edited
  /// captions so user edits aren't overwritten by rawWords-derived text.
  edited?: boolean;
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
  /// Path relative to the .cod file's directory. Stored on save when the
  /// media lives on the same drive as the project; used on load to resolve
  /// back to an absolute `path`. Lets .cod + media survive being shared via
  /// a cloud folder that syncs to different absolute roots on each machine.
  relativePath?: string;
  fps: number | null;  // probed from file; null = audio-only or unknown (use profile default)
  vfr?: boolean;       // true if variable frame rate detected (frame-snapping may be imprecise)
  hasAudio?: boolean;  // probed from file; false = no audio stream, so transcription is blocked
  dropFrame?: boolean; // true = DF, false = NDF; auto-set for 29.97/59.94, user-overridable
  captions: CaptionBlock[];
  rawWords?: Word[];              // persisted for future re-pipeline without re-transcribing
  generatedAt?: string;
  generatedWithModel?: TranscriptionModel;
  generatedWithLanguage?: string; // the user's selection; absent means auto-detect was used
  detectedLanguage?: string;      // set when auto-detect was used
  /// True when word-level forced alignment failed on the last generation
  /// and captions are using segment-level timing. Surfaced as a warning
  /// badge so users know to consider regenerating.
  alignmentDegraded?: boolean;
  exports: ExportRecord[];
}

export type TranscriptionModel = "tiny" | "base" | "small" | "medium" | "large-v3";

export interface CodProject {
  version: number;
  name: string;
  transcriptionModel: TranscriptionModel;
  language: string;
  createdAt: string;
  updatedAt: string;
  media: MediaItem[];
  exportFormatName?: string;
  exportFormatHash?: string;
  profileName?: string;
  profileHash?: string;
}
