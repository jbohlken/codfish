import { signal } from "@preact/signals";

export const errorModal = signal<string | null>(null);

export function showError(message: string) {
  errorModal.value = message;
}

export function ErrorModal() {
  const message = errorModal.value;
  if (!message) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(message).catch(() => {});
  };

  return (
    <div class="error-modal-backdrop" onClick={() => { errorModal.value = null; }}>
      <div class="error-modal" onClick={(e) => e.stopPropagation()}>
        <div class="error-modal-header">
          <span class="error-modal-title">Error</span>
          <button class="btn btn-ghost btn-icon" onClick={() => { errorModal.value = null; }}>✕</button>
        </div>
        <pre class="error-modal-body">{message}</pre>
        <div class="error-modal-footer">
          <button class="btn btn-secondary" onClick={handleCopy}>Copy</button>
          <button class="btn btn-primary" onClick={() => { errorModal.value = null; }}>Dismiss</button>
        </div>
      </div>
    </div>
  );
}
