import {
  selectedMedia,
  activeProfile,
  exportFormats,
  selectedExportFormat,
} from "../store/app";
import { runBatchGeneration, eligibleMediaIds, allTranscribableMediaIds, captionedMedia } from "./batch";
import { exportCaptions, exportCaptionsBulk, type BulkExportItem, type BulkExportResult } from "./export";
import { showError } from "../components/ErrorModal";
import { showNotice } from "../components/NoticeModal";
import { confirmUnsavedChanges } from "../components/UnsavedChanges";

// ── Generation ────────────────────────────────────────────────────────────

/** Generate captions for the currently-selected media. If it already has
 * captions, confirm first (this is a destructive regenerate). */
export async function generateSelectedMedia(): Promise<void> {
  const media = selectedMedia.value;
  if (!media) return;

  if (media.captions.length > 0) {
    const choice = await confirmUnsavedChanges(
      `Regenerating will replace the existing captions for "${media.name}".`,
      { title: "Regenerate captions?", hideDiscard: true, confirmLabel: "Regenerate" },
    );
    if (choice !== "save") return;
  }

  await runBatchGeneration([media.id]);
}

/** Generate captions for every media that doesn't have them yet. Non-
 * destructive — already-captioned media are left untouched. */
export async function generateMissingMedia(): Promise<void> {
  const ids = eligibleMediaIds.value;
  if (ids.length === 0) return;
  await runBatchGeneration(ids);
}

/** Regenerate captions for every transcribable media, replacing any existing
 * captions and manual edits. Destructive — confirms first. */
export async function regenerateAllMedia(): Promise<void> {
  const ids = allTranscribableMediaIds.value;
  if (ids.length === 0) return;

  const choice = await confirmUnsavedChanges(
    `This will regenerate captions for all ${ids.length} media file${ids.length === 1 ? "" : "s"}, replacing any existing captions and manual edits.`,
    { title: "Regenerate everything?", hideDiscard: true, confirmLabel: "Regenerate everything" },
  );
  if (choice !== "save") return;

  await runBatchGeneration(ids);
}

// ── Export ─────────────────────────────────────────────────────────────────

/** Surface the outcome of a bulk export run. */
function reportBulkExport(result: BulkExportResult | null, attempted: number): void {
  if (!result) return; // cancelled folder picker
  if (result.failed.length > 0) {
    const lines = result.failed.map((f) => `• ${f.name}: ${f.error}`);
    showError(`Exported ${result.written.length} of ${attempted} file(s).\n\nFailed:\n${lines.join("\n")}`);
  } else {
    showNotice(
      "Export complete",
      `Exported ${result.written.length} caption file${result.written.length === 1 ? "" : "s"} to:\n${result.folder}`,
    );
  }
}

function resolveFormat() {
  return exportFormats.value.find((f) => f.id === selectedExportFormat.value) ?? null;
}

function mediaFps(fps: number | null): number {
  return fps ?? activeProfile.value.timing.defaultFps;
}

/** Export the currently-selected media's captions (single save dialog). */
export async function exportSelectedMedia(): Promise<void> {
  const media = selectedMedia.value;
  if (!media || media.captions.length === 0) return;

  const format = resolveFormat();
  if (!format) {
    showError("No export format selected.");
    return;
  }

  try {
    await exportCaptions(format, media.captions, media.name, mediaFps(media.fps), media.dropFrame ?? false);
  } catch (e) {
    showError(String(e));
  }
}

/** Export every captioned media into a single chosen folder. */
export async function exportAllMedia(): Promise<void> {
  const captioned = captionedMedia.value;
  if (captioned.length === 0) return;

  const format = resolveFormat();
  if (!format) {
    showError("No export format selected.");
    return;
  }

  const items: BulkExportItem[] = captioned.map((m) => ({
    name: m.name,
    captions: m.captions,
    fps: mediaFps(m.fps),
    dropFrame: m.dropFrame ?? false,
  }));

  try {
    reportBulkExport(await exportCaptionsBulk(format, items), items.length);
  } catch (e) {
    showError(String(e));
  }
}
