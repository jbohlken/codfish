import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";

/** Number of open escape-closable popups. Doubles as the app's reactive
 *  "a modal is open" signal for menu-item gating — every modal registers
 *  here through useEscapeToClose. (RecoveryPrompt is the one deliberate
 *  exception: it has no safe Escape meaning and only appears at boot, before
 *  a project exists; keyboard handlers still see it via isAppModalOpen's
 *  DOM check.) */
export const openPopupCount = signal(0);

/** Active handlers, in registration (= mount) order. Escape fires ONLY the
 *  most recently registered one — the popup visually on top. Document-level
 *  listeners can't shield each other (stopPropagation does not stop other
 *  listeners on the same node), so per-popup listeners would ALL see the key;
 *  a single listener dispatching to the top of a stack makes layering
 *  deterministic: the unsaved-changes dialog over an editor owns Escape
 *  outright, and the editor underneath can never also react. */
const stack: { onClose: () => void }[] = [];
let listening = false;

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  // Escape during IME composition cancels the conversion — it must never
  // also close a popup (mirrors CaptionEditor's guard; keyCode 229 covers
  // engines that fire the key with isComposing already false).
  if (e.isComposing || e.keyCode === 229) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  // preventDefault + stopPropagation so the key can't also reach app-level
  // handlers (clear-caption-selection, editor cancel) while a popup is up.
  e.preventDefault();
  e.stopPropagation();
  top.onClose();
}

function sync() {
  openPopupCount.value = stack.length;
  if (stack.length > 0 && !listening) {
    document.addEventListener("keydown", onKey, true);
    listening = true;
  } else if (stack.length === 0 && listening) {
    document.removeEventListener("keydown", onKey, true);
    listening = false;
  }
}

/** Close a popup on Escape — the app-wide rule for every popup: dismissal
 *  modals close directly; the editors (Format/Profile managers, caption
 *  style) pass their guarded close so Escape routes through their
 *  unsaved-changes flow. The registered entry is stable across re-renders
 *  (handler kept in a ref) so the stack order always reflects mount order. */
export function useEscapeToClose(active: boolean, onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!active) return;
    const entry = { onClose: () => ref.current() };
    stack.push(entry);
    sync();
    return () => {
      const i = stack.indexOf(entry);
      if (i !== -1) stack.splice(i, 1);
      sync();
    };
  }, [active]);
}
