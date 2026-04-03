import { signal } from "@preact/signals";

interface UnsavedChangesState {
  message: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export const unsavedChanges = signal<UnsavedChangesState | null>(null);

/**
 * Show the unsaved changes modal and return what the user chose.
 * Resolves to "save", "discard", or "cancel".
 */
export function confirmUnsavedChanges(message = "You have unsaved changes."): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    unsavedChanges.value = {
      message,
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
    <div class="modal-backdrop" onClick={state.onCancel}>
      <div class="confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div class="confirm-modal-header">
          <span class="confirm-modal-title">Unsaved changes</span>
        </div>
        <div class="confirm-modal-body">
          <p>{state.message}</p>
          <p>Do you want to save before continuing?</p>
        </div>
        <div class="confirm-modal-footer">
          <button class="btn btn-ghost btn-sm" onClick={state.onCancel}>Cancel</button>
          <button class="btn btn-secondary btn-sm" onClick={state.onDiscard}>Discard</button>
          <button class="btn btn-primary btn-sm" onClick={state.onSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
