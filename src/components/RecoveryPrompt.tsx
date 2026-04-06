import { signal } from "@preact/signals";

interface RecoveryPromptState {
  savedAt: string;
  onRestore: () => void;
  onDiscard: () => void;
}

export const recoveryPrompt = signal<RecoveryPromptState | null>(null);

/** Show the recovery prompt and resolve to true (restore) or false (discard). */
export function askRestoreRecovery(savedAt: string): Promise<boolean> {
  return new Promise((resolve) => {
    recoveryPrompt.value = {
      savedAt,
      onRestore: () => { recoveryPrompt.value = null; resolve(true); },
      onDiscard: () => { recoveryPrompt.value = null; resolve(false); },
    };
  });
}

export function RecoveryPrompt() {
  const state = recoveryPrompt.value;
  if (!state) return null;

  const when = new Date(state.savedAt).toLocaleString();

  return (
    <div class="modal-backdrop" onClick={state.onDiscard}>
      <div class="confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div class="confirm-modal-header">
          <span class="confirm-modal-title">Recover unsaved work?</span>
        </div>
        <div class="confirm-modal-body">
          <p>An unsaved project snapshot was found from <strong>{when}</strong>.</p>
          <p>Would you like to restore it?</p>
        </div>
        <div class="confirm-modal-footer">
          <button class="btn btn-secondary btn-sm" onClick={state.onDiscard}>Discard</button>
          <button class="btn btn-primary btn-sm" onClick={state.onRestore}>Restore</button>
        </div>
      </div>
    </div>
  );
}
