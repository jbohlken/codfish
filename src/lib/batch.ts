import { computed } from "@preact/signals";
import {
  project,
  isDirty,
  pushHistory,
  activeProfile,
  batchState,
  batchProgress,
  batchCancelRequested,
  type BatchItemStatus,
} from "../store/app";
import { transcribeMedia } from "./transcription";
import { runPipeline } from "./pipeline";
import { fileExists } from "./project";
import { showError } from "../components/ErrorModal";
import type { CodProject, MediaItem, Word, CaptionBlock } from "../types/project";

interface BatchResult {
  mediaId: string;
  words: Word[];
  captions: CaptionBlock[];
  generatedAt: string;
  model: CodProject["transcriptionModel"];
  generatedWithLanguage: string | undefined;
  detectedLanguage: string | undefined;
  alignmentDegraded: boolean;
}

function applyResultToMedia(m: MediaItem, r: BatchResult): MediaItem {
  return {
    ...m,
    captions: r.captions,
    rawWords: r.words,
    generatedAt: r.generatedAt,
    generatedWithModel: r.model,
    generatedWithLanguage: r.generatedWithLanguage,
    detectedLanguage: r.detectedLanguage,
    alignmentDegraded: r.alignmentDegraded,
  };
}

/** Run caption generation across the given media IDs sequentially.
 *
 * Callers pick the IDs (so the regenerate-one-file path can pass [mediaId]
 * and the project-wide trigger can pass eligible IDs). Results land in a
 * single history entry at the end; partial completion (cancel / failures)
 * still commits the successful subset.
 */
export async function runBatchGeneration(mediaIds: string[]): Promise<void> {
  if (mediaIds.length === 0) return;
  if (batchState.value !== null) return;
  if (!project.value) return;

  const statuses = new Map<string, BatchItemStatus>(
    mediaIds.map((id) => [id, "pending"]),
  );
  const errors = new Map<string, string>();
  const commit = () => {
    batchState.value = {
      ids: mediaIds,
      statuses: new Map(statuses),
      errors: new Map(errors),
    };
  };

  const results: BatchResult[] = [];

  // try/finally guarantees we always release batchState even if anything
  // below — the initial commit(), per-iteration commit(), runPipeline,
  // applyResultToMedia, pushHistory, signal writes — throws unexpectedly.
  // Without it an exception would leave the BatchBlocker up indefinitely.
  try {
    batchCancelRequested.value = false;
    batchProgress.value = null;
    commit();

    for (const id of mediaIds) {
      if (batchCancelRequested.value) {
        for (const remaining of mediaIds) {
          if (statuses.get(remaining) === "pending") {
            statuses.set(remaining, "cancelled");
          }
        }
        commit();
        break;
      }

      const current = project.value;
      if (!current) break;
      const media = current.media.find((m) => m.id === id);

      if (!media) {
        statuses.set(id, "failed");
        errors.set(id, "Media not found in project");
        commit();
        continue;
      }
      if (media.hasAudio === false) {
        statuses.set(id, "failed");
        errors.set(id, "No audio track");
        commit();
        continue;
      }
      if (!(await fileExists(media.path))) {
        statuses.set(id, "failed");
        errors.set(id, "File not found");
        commit();
        continue;
      }

      statuses.set(id, "running");
      batchProgress.value = { stage: "transcribing", percent: 0, message: "Starting up…" };
      commit();

      try {
        const { words, detectedLanguage, alignmentDegraded } = await transcribeMedia(
          media.path,
          current.transcriptionModel,
          current.language || null,
          (p) => { batchProgress.value = p; },
        );
        const { captions } = runPipeline(words, activeProfile.value, media.fps ?? undefined);
        const autoDetect = !current.language;
        const result: BatchResult = {
          mediaId: id,
          words,
          captions,
          generatedAt: new Date().toISOString(),
          model: current.transcriptionModel,
          generatedWithLanguage: autoDetect ? undefined : current.language,
          detectedLanguage: autoDetect ? detectedLanguage : undefined,
          alignmentDegraded,
        };
        results.push(result);
        // Live-apply to project so users navigating to a completed file see
        // its captions immediately. No history entry yet — that comes at end
        // of batch as a single combined "Generate captions (N files)" step.
        const latest: CodProject | null = project.value;
        if (latest) {
          project.value = {
            ...latest,
            media: latest.media.map((m) => m.id === id ? applyResultToMedia(m, result) : m),
          };
          isDirty.value = true;
        }
        statuses.set(id, "done");
      } catch (e) {
        errors.set(id, String(e));
        statuses.set(id, "failed");
      }
      batchProgress.value = null;
      commit();
    }

    if (results.length > 0) {
      const current: CodProject | null = project.value;
      if (current) {
        const byId = new Map(results.map((r) => [r.mediaId, r] as const));
        const newProject: CodProject = {
          ...current,
          media: current.media.map((m) => {
            const r = byId.get(m.id);
            return r ? applyResultToMedia(m, r) : m;
          }),
        };
        const total = mediaIds.length;
        const success = results.length;
        const desc = total === 1
          ? "Generate captions"
          : success === total
            ? `Generate captions (${total} files)`
            : `Generate captions (${success} of ${total} files)`;
        pushHistory(newProject, desc);
      }
    }

    if (errors.size > 0) {
      const lines = [...errors.entries()].map(([id, msg]) => {
        const name = project.value?.media.find((m) => m.id === id)?.name ?? id;
        return `• ${name}: ${msg}`;
      });
      const n = errors.size;
      showError(`Failed to generate captions for ${n} file${n === 1 ? "" : "s"}:\n${lines.join("\n")}`);
    }
  } finally {
    batchState.value = null;
    batchProgress.value = null;
    batchCancelRequested.value = false;
  }
}

export function cancelBatch(): void {
  if (batchState.value === null) return;
  batchCancelRequested.value = true;
}

/** Media that haven't been generated yet and have (or might have) audio.
 * `hasAudio === false` is the only definitive "skip"; undefined means the
 * probe never ran or failed, in which case we let the attempt happen.
 *
 * Computed signal so callers (TitleBar render, actions) automatically
 * subscribe and so the filter cost is paid once per project change instead
 * of on every render. */
export const eligibleMediaIds = computed((): string[] => {
  const proj = project.value;
  if (!proj) return [];
  return proj.media
    .filter((m) => m.captions.length === 0 && m.hasAudio !== false)
    .map((m) => m.id);
});

/** Every media that can be transcribed, regardless of whether it already
 * has captions. Used by the destructive "Regenerate everything" action. */
export const allTranscribableMediaIds = computed((): string[] => {
  const proj = project.value;
  if (!proj) return [];
  return proj.media.filter((m) => m.hasAudio !== false).map((m) => m.id);
});

/** Media items that already have captions. Used by exportAllMedia to build
 * the bulk-export item list. */
export const captionedMedia = computed((): MediaItem[] => {
  const proj = project.value;
  if (!proj) return [];
  return proj.media.filter((m) => m.captions.length > 0);
});

/** Number of media items that already have captions. Derived from
 * captionedMedia so the predicate lives in exactly one place. Used to gate
 * the "Regenerate everything" action and to label the "Export all" item. */
export const captionedMediaCount = computed((): number => captionedMedia.value.length);
