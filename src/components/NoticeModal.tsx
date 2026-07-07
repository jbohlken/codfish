import { signal } from "@preact/signals";
import { XIcon as X, CheckSquareIcon as CheckSquare, SquareIcon as Square } from "@phosphor-icons/react";
import { useEscapeToClose } from "../lib/useEscapeToClose";
import { useBackdropClose } from "../lib/useBackdropClose";

interface NoticeState {
  title: string;
  message: string;
  /** Optional "don't remind me again"-style checkbox label. */
  checkboxLabel?: string;
  /** Called once when the modal closes (any path), with the checkbox state. */
  onDismiss?: (checked: boolean) => void;
}

export const noticeModal = signal<NoticeState | null>(null);
const noticeChecked = signal(false);

/** Show a neutral informational modal (e.g. "Export complete"). Mirrors the
 * structure of ErrorModal but with a neutral title color and a single
 * OK/dismiss button — no Copy. Use ErrorModal for failures, this for
 * positive confirmations or other non-error notices. Pass `checkboxLabel` +
 * `onDismiss` for a "don't remind me again" affordance — onDismiss fires on
 * every close path with the checkbox state. */
export function showNotice(
  title: string,
  message: string,
  opts?: { checkboxLabel?: string; onDismiss?: (checked: boolean) => void },
) {
  noticeChecked.value = false;
  noticeModal.value = { title, message, ...opts };
}

/** Close the notice through the normal path (onDismiss fires, honoring the
 *  "every close path" contract). Exported for the exit gate: informational
 *  popups step aside when the user quits. No-op when nothing is showing. */
export function dismissNotice() {
  const state = noticeModal.value;
  noticeModal.value = null;
  state?.onDismiss?.(noticeChecked.value);
}
const dismiss = dismissNotice;

export function NoticeModal() {
  const state = noticeModal.value;
  useEscapeToClose(!!state, dismiss);
  const backdropProps = useBackdropClose(dismiss);
  if (!state) return null;

  return (
    <div class="notice-modal-backdrop" {...backdropProps}>
      <div class="notice-modal" onClick={(e) => e.stopPropagation()}>
        <div class="notice-modal-header">
          <span class="notice-modal-title">{state.title}</span>
          <button class="btn btn-ghost btn-icon" onClick={dismiss}><X size={14} /></button>
        </div>
        <pre class="notice-modal-body">{state.message}</pre>
        {state.checkboxLabel && (
          /* Same check idiom as the replace options menu (Square/CheckSquare). */
          <button
            type="button"
            class="notice-modal-checkbox"
            role="checkbox"
            aria-checked={noticeChecked.value}
            onClick={() => { noticeChecked.value = !noticeChecked.value; }}
          >
            {noticeChecked.value ? <CheckSquare size={14} /> : <Square size={14} />}
            <span>{state.checkboxLabel}</span>
          </button>
        )}
        <div class="notice-modal-footer">
          <button class="btn btn-primary" onClick={dismiss}>OK</button>
        </div>
      </div>
    </div>
  );
}
