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
