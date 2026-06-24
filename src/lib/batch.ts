import { computed } from "@preact/signals";
import {
  project,
  isDirty,
  pushHistory,
  activeProfile,
  batchState,
  batchProgress,
  batchCancelRequested,
  selectedMediaIds,
  selectedBinIds,
  sortMode,
  sortDir,
  type BatchItemStatus,
} from "../store/app";
import { collectSubtree, orderMediaIdsForDisplay } from "./bins";
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
/** All project media in panel-display order (active sort + bin nesting). Every
 * list below derives from this, so batch generation and bulk export iterate in
 * the order the user sees rows in the panel rather than raw import order. */
export const displayOrderedMedia = computed((): MediaItem[] => {
  const proj = project.value;
  if (!proj) return [];
  const byId = new Map(proj.media.map((m) => [m.id, m]));
  return orderMediaIdsForDisplay(proj.media, proj.bins ?? [], sortMode.value, sortDir.value)
    .map((id) => byId.get(id))
    .filter((m): m is MediaItem => m !== undefined);
});

export const eligibleMediaIds = computed((): string[] =>
  displayOrderedMedia.value
    .filter((m) => m.captions.length === 0 && m.hasAudio !== false)
    .map((m) => m.id),
);

/** Every media that can be transcribed, regardless of whether it already
 * has captions. Used by the destructive "Regenerate everything" action. */
export const allTranscribableMediaIds = computed((): string[] =>
  displayOrderedMedia.value.filter((m) => m.hasAudio !== false).map((m) => m.id),
);

/** Media items that already have captions. Used by exportAllMedia to build
 * the bulk-export item list. */
export const captionedMedia = computed((): MediaItem[] =>
  displayOrderedMedia.value.filter((m) => m.captions.length > 0),
);

/** Number of media items that already have captions. Derived from
 * captionedMedia so the predicate lives in exactly one place. Used to gate
 * the "Regenerate everything" action and to label the "Export all" item. */
export const captionedMediaCount = computed((): number => captionedMedia.value.length);

// ── Selection scope ──────────────────────────────────────────────────────────
// The "selection" scope for the generate/export menus: every clip inside a
// selected bin's subtree (recursive) plus any directly-selected clips, deduped.
// Empty unless the selection is more than the single active clip, so the scoped
// menu section only appears when it's meaningful. The same predicates as the
// project-scope lists are reused below, so the gating stays in one place.

/** Media in the current selection scope (bins' subtrees ∪ selected clips). */
export const selectionScopeMedia = computed((): MediaItem[] => {
  const proj = project.value;
  if (!proj) return [];
  const binIds = selectedBinIds.value;
  const clipIds = selectedMediaIds.value;
  // Only the single active clip selected (or nothing) → no distinct scope.
  if (binIds.size === 0 && clipIds.size <= 1) return [];
  const subtreeBins = new Set<string>();
  for (const b of binIds) for (const id of collectSubtree(proj.bins ?? [], b)) subtreeBins.add(id);
  // Filter the display-ordered list so the scope keeps panel order too.
  return displayOrderedMedia.value.filter(
    (m) => clipIds.has(m.id) || (m.binId !== undefined && subtreeBins.has(m.binId)),
  );
});

/** Selection-scoped counterparts of the project-scope lists (same predicates). */
export const selectionEligibleIds = computed((): string[] =>
  selectionScopeMedia.value.filter((m) => m.captions.length === 0 && m.hasAudio !== false).map((m) => m.id),
);
export const selectionTranscribableIds = computed((): string[] =>
  selectionScopeMedia.value.filter((m) => m.hasAudio !== false).map((m) => m.id),
);
export const selectionCaptionedMedia = computed((): MediaItem[] =>
  selectionScopeMedia.value.filter((m) => m.captions.length > 0),
);
