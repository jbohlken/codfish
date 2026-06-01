import { useEffect } from "preact/hooks";
import {
  batchState,
  batchProgress,
  batchCancelRequested,
  batchCurrentId,
  project,
} from "../store/app";
import { cancelBatch } from "../lib/batch";
import { CheckIcon as Check, ArrowsClockwiseIcon as ArrowsClockwise, XIcon as XMark } from "@phosphor-icons/react";

/** Full-screen blocker shown while a caption-generation batch is running. The
 * app-shell is inert during this window, so this modal owns all interaction
 * (progress display + Cancel). Mirrors the UpdateBlocker pattern. */
export function BatchBlocker() {
  const batch = batchState.value;
  if (!batch) return null;

  const proj = project.value;
  const total = batch.ids.length;
  let done = 0;
  for (const id of batch.ids) {
    const s = batch.statuses.get(id);
    if (s === "done" || s === "failed" || s === "cancelled") done++;
  }
  const progress = batchProgress.value;
  const cancelling = batchCancelRequested.value;
  const currentId = batchCurrentId.value;
  // Smooth overall percent: include the running file's partial progress.
  const runningFrac = currentId ? (progress?.percent ?? 0) / 100 : 0;
  const overallPercent = total === 0 ? 0 : Math.min(100, ((done + runningFrac) / total) * 100);

  const nameOf = (id: string) => proj?.media.find((m) => m.id === id)?.name ?? id;

  // Keep the running row visible as the batch progresses. `block: "nearest"`
  // is a no-op when the row is already on-screen, so a user who scrolled up
  // to inspect a failed row earlier in the list isn't yanked back down.
  useEffect(() => {
    if (!currentId) return;
    document.querySelector(`[data-batch-id="${currentId}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [currentId]);

  return (
    <div class="batch-blocker">
      <div class="batch-blocker-card">
        <div class="batch-blocker-title">Generating captions</div>
        <div class="batch-blocker-summary">{done} of {total} complete</div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style={{ width: `${overallPercent}%` }} />
        </div>
        <div class="batch-blocker-list scrollable">
          {batch.ids.map((id) => {
            const status = batch.statuses.get(id) ?? "pending";
            const isRunning = id === currentId;
            const error = batch.errors.get(id);
            return (
              <div
                key={id}
                data-batch-id={id}
                class={`batch-blocker-row batch-blocker-row--${status}`}
              >
                <span class="batch-blocker-row-icon">
                  {status === "done" && <Check size={14} />}
                  {status === "failed" && <XMark size={14} />}
                  {status === "running" && <ArrowsClockwise size={14} className="batch-spin" />}
                  {(status === "pending" || status === "cancelled") && (
                    <span class="batch-blocker-row-dot">·</span>
                  )}
                </span>
                <span class="batch-blocker-row-name">{nameOf(id)}</span>
                {isRunning && progress?.message && (
                  <span class="batch-blocker-row-msg">{progress.message}</span>
                )}
                {status === "failed" && error && (
                  <span class="batch-blocker-row-msg batch-blocker-row-msg--error">{error}</span>
                )}
              </div>
            );
          })}
        </div>
        <div class="batch-blocker-actions">
          <button
            class="btn btn-secondary btn-sm"
            disabled={cancelling}
            onClick={cancelBatch}
          >
            {cancelling ? "Stopping…" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
