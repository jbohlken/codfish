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
  /// ISO timestamp of when the file was imported into the project. Optional:
  /// projects created before this field existed have media without it, and
  /// the panel's "Date added" sort falls back to media-array order for those
  /// (array order == import order, since media is only ever appended). New
  /// imports always carry it.
  addedAt?: string;
  rawWords?: Word[];              // persisted for future re-pipeline without re-transcribing
  generatedAt?: string;
  generatedWithModel?: TranscriptionModel;
  generatedWithLanguage?: string; // the user's selection; absent means auto-detect was used
  detectedLanguage?: string;      // set when auto-detect was used
  /// True when word-level forced alignment failed on the last generation
  /// and captions are using segment-level timing. Surfaced as a warning
  /// badge so users know to consider regenerating.
  alignmentDegraded?: boolean;
  /// Id of the bin this media belongs to (see CodProject.bins). Absent — or
  /// referencing a bin that no longer exists — means ungrouped. Optional and
  /// additive: projects created before bins existed have no binId and render
  /// ungrouped, exactly as before.
  binId?: string;
  exports: ExportRecord[];
}

export type TranscriptionModel = "tiny" | "base" | "small" | "medium" | "large-v3";

/// A user-created folder/bin for organizing media within a project. Order in
/// the array is the display order. Collapsed state is intentionally NOT stored
/// here — it's per-user view state kept in localStorage, so toggling a bin
/// open/closed never enters the undo history. Optional + additive on
/// CodProject: older files have no `bins` and render everything ungrouped.
export interface Bin {
  id: string;
  name: string;
}

export interface CodProject {
  version: number;
  name: string;
  transcriptionModel: TranscriptionModel;
  language: string;
  createdAt: string;
  updatedAt: string;
  media: MediaItem[];
  /// User-created bins for organizing media. Optional + additive — absent in
  /// projects created before bins existed (everything renders ungrouped).
  bins?: Bin[];
  exportFormatName?: string;
  exportFormatHash?: string;
  profileName?: string;
  profileHash?: string;
}
