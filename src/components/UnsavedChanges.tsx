import { signal } from "@preact/signals";

interface UnsavedChangesState {
  message: string;
  title: string;
  hideDiscard: boolean;
  confirmLabel: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export const unsavedChanges = signal<UnsavedChangesState | null>(null);

interface ConfirmOptions {
  title?: string;
  hideDiscard?: boolean;
  confirmLabel?: string;
}

/**
 * Show the unsaved changes modal and return what the user chose.
 * Resolves to "save", "discard", or "cancel".
 */
export function confirmUnsavedChanges(
  message = "You have unsaved changes. Do you want to save before continuing?",
  options: ConfirmOptions = {},
): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    unsavedChanges.value = {
      message,
      title: options.title ?? "Unsaved changes",
      hideDiscard: options.hideDiscard ?? false,
      confirmLabel: options.confirmLabel ?? "Save",
      onSave:    () => { unsavedChanges.value = null; resolve("save"); },
      onDiscard: () => { unsavedChanges.value = null; resolve("discard"); },
      onCancel:  () => { unsavedChanges.value = null; resolve("cancel"); },
    };
  });
}

export function UnsavedChanges() {
  const state = unsavedChanges.value;
  if (!state) return null;

  return (
    <div class="modal-backdrop">
      <div class="confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div class="confirm-modal-header">
          <span class="confirm-modal-title">{state.title}</span>
        </div>
        <div class="confirm-modal-body">
          <p>{state.message}</p>
        </div>
        <div class="confirm-modal-footer">
          <button class="btn btn-ghost btn-sm" onClick={state.onCancel}>Cancel</button>
          {!state.hideDiscard && (
            <button class="btn btn-secondary btn-sm" onClick={state.onDiscard}>Discard</button>
          )}
          <button class="btn btn-primary btn-sm" onClick={state.onSave}>{state.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
