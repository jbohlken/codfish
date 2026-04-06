import { signal } from "@preact/signals";
import { useState } from "preact/hooks";
import { XIcon as X, CheckCircleIcon as CheckCircle } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";

export const bugReportOpen = signal(false);

type FeedbackKind = "bug" | "feature";

export function BugReportModal() {
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ url: string; number: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!bugReportOpen.value) return null;

  const close = () => {
    bugReportOpen.value = false;
    setKind("bug");
    setTitle("");
    setDescription("");
    setResult(null);
    setError(null);
  };

  const submit = async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await invoke<{ url: string; number: number }>("submit_bug_report", {
        report: { title: title.trim(), description: description.trim(), kind },
      });
      setResult(res);
    } catch (e: any) {
      setError(typeof e === "string" ? e : e.message || "Failed to submit feedback");
    } finally {
      setSubmitting(false);
    }
  };

  const isBug = kind === "bug";

  return (
    <div class="modal-backdrop" onClick={close}>
      <div class="help-modal" onClick={(e) => e.stopPropagation()}>
        <div class="help-modal-header">
          <span class="help-modal-title">Submit Feedback</span>
          <button class="btn btn-ghost btn-icon" onClick={close}><X size={14} /></button>
        </div>

        <div class="help-modal-body">
          {result ? (
            <div class="bug-report-success">
              <CheckCircle size={32} weight="fill" />
              <p>Feedback submitted! (#{result.number})</p>
              <p class="bug-report-thanks">Thank you for your feedback.</p>
            </div>
          ) : (
            <>
              <div class="bug-report-field">
                <label class="bug-report-label">Type</label>
                <div class="bug-report-kind">
                  <button
                    type="button"
                    class={`btn ${isBug ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setKind("bug")}
                    disabled={submitting}
                  >
                    Bug report
                  </button>
                  <button
                    type="button"
                    class={`btn ${!isBug ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setKind("feature")}
                    disabled={submitting}
                  >
                    Feature request
                  </button>
                </div>
              </div>
              <div class="bug-report-field">
                <label class="bug-report-label">Title</label>
                <input
                  class="bug-report-input"
                  type="text"
                  placeholder={isBug ? "Brief summary of the issue" : "Brief summary of the idea"}
                  value={title}
                  onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
                  disabled={submitting}
                />
              </div>
              <div class="bug-report-field">
                <label class="bug-report-label">Description</label>
                <textarea
                  class="bug-report-textarea"
                  placeholder={isBug ? "What happened? What did you expect?" : "What would you like to see? Why would it help?"}
                  value={description}
                  onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
                  disabled={submitting}
                  rows={5}
                />
              </div>
              <p class="bug-report-hint">System info (OS, app version) will be attached automatically.</p>
              {error && <p class="bug-report-error">{error}</p>}
              <button
                class="btn btn-primary btn-full"
                onClick={submit}
                disabled={submitting || !title.trim()}
              >
                {submitting ? "Submitting..." : "Submit Feedback"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
