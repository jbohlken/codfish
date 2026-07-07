/** True when the event originates from a text-entry surface — inputs,
 *  selects, textareas, or any contenteditable region (the caption editor).
 *  Document-level single-key shortcut handlers must not fire from these. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** True while any modal is open (every modal renders one of these
 *  backdrops). Document-level shortcut handlers must go inert then — a bare
 *  Ctrl+Z / zoom / trim with focus on a modal button would otherwise mutate
 *  the project invisibly behind the modal. DOM check rather than a
 *  hand-enumerated signal list so new modals are covered automatically; for
 *  reactive contexts (the menu-enable effect) use openPopupCount from
 *  useEscapeToClose instead. */
export function isAppModalOpen(): boolean {
  return document.querySelector(".modal-backdrop, .notice-modal-backdrop, .error-modal-backdrop") !== null;
}
