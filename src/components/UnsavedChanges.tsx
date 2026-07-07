import { signal } from "@preact/signals";
import { useEscapeToClose } from "../lib/useEscapeToClose";

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
    // Each handler clears the slot only if THIS dialog still owns it — a
    // stale handler (held by a displaced dialog's render or listener) must
    // never destroy a successor dialog's state, which would leave the
    // successor's promise unresolvable.
    const clear = () => {
      if (unsavedChanges.value === state) unsavedChanges.value = null;
    };
    const state: UnsavedChangesState = {
      message,
      title: options.title ?? "Unsaved changes",
      hideDiscard: options.hideDiscard ?? false,
      confirmLabel: options.confirmLabel ?? "Save",
      onSave:    () => { clear(); resolve("save"); },
      onDiscard: () => { clear(); resolve("discard"); },
      onCancel:  () => { clear(); resolve("cancel"); },
    };
    // Single slot: a second caller (e.g. a native menu action while a guard
    // is already up) displaces the pending dialog. Resolve the displaced
    // promise as "cancel" so its caller's guard flow unwinds instead of
    // awaiting forever.
    unsavedChanges.value?.onCancel();
    unsavedChanges.value = state;
  });
}

export function UnsavedChanges() {
  const state = unsavedChanges.value;
  // Escape = Cancel, the safe choice (never discards or saves implicitly).
  useEscapeToClose(!!state, () => state?.onCancel());
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
