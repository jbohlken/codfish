import { signal } from "@preact/signals";
import { XIcon as X } from "@phosphor-icons/react";

interface NoticeState {
  title: string;
  message: string;
}

export const noticeModal = signal<NoticeState | null>(null);

/** Show a neutral informational modal (e.g. "Export complete"). Mirrors the
 * structure of ErrorModal but with a neutral title color and a single
 * OK/dismiss button — no Copy. Use ErrorModal for failures, this for
 * positive confirmations or other non-error notices. */
export function showNotice(title: string, message: string) {
  noticeModal.value = { title, message };
}

export function NoticeModal() {
  const state = noticeModal.value;
  if (!state) return null;

  return (
    <div class="notice-modal-backdrop" onClick={() => { noticeModal.value = null; }}>
      <div class="notice-modal" onClick={(e) => e.stopPropagation()}>
        <div class="notice-modal-header">
          <span class="notice-modal-title">{state.title}</span>
          <button class="btn btn-ghost btn-icon" onClick={() => { noticeModal.value = null; }}><X size={14} /></button>
        </div>
        <pre class="notice-modal-body">{state.message}</pre>
        <div class="notice-modal-footer">
          <button class="btn btn-primary" onClick={() => { noticeModal.value = null; }}>OK</button>
        </div>
      </div>
    </div>
  );
}
