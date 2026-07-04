import { useEffect } from "preact/hooks";

/** Close a popup on Escape — the app-wide rule for dismissal-style modals
 *  (notices, errors, confirms, About, Media Settings). Capture phase +
 *  stopPropagation so the key can't also reach app-level handlers
 *  (clear-caption-selection, editor cancel) while the popup is up. The
 *  manager modals (Format/Profile) deliberately do NOT use this: they exit
 *  through their unsaved-changes guard via the X button. */
export function useEscapeToClose(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [active, onClose]);
}
