import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { XIcon as X } from "@phosphor-icons/react";
import { StyledLines } from "./StyledLines";
import { confirmUnsavedChanges } from "./UnsavedChanges";
import { useEscapeToClose } from "../lib/useEscapeToClose";
import { useBackdropClose } from "../lib/useBackdropClose";
import {
  DEFAULT_CAPTION_PREVIEW_CSS,
  effectiveCaptionCss,
  getPreviewSheet,
  isEffectivelyEmpty,
  lintCaptionCss,
  saveCaptionCss,
  setPreviewSheet,
  validateCaptionCss,
} from "../lib/captionPreviewCss";
import type { StyleSpan } from "../types/project";

export const captionStyleOpen = signal(false);

// The mounted editor registers its guarded close here (the FormatManager
// _guardLeave idiom) so menu actions can ask it to step aside.
let _requestClose: (() => Promise<boolean>) | null = null;

/** Ask the caption style editor to close, respecting its dirty guard.
 *  Returns true if it closed (or wasn't open), false if the user cancelled. */
export async function requestCloseCaptionStyle(): Promise<boolean> {
  if (!captionStyleOpen.value) return true;
  if (_requestClose) return _requestClose();
  captionStyleOpen.value = false;
  return true;
}

// Sample caption for the in-panel strip — real StyledLines markup exercising
// all three styles, for sessions where no video/caption is on screen.
const SAMPLE_LINES = ["The tide turns fast out here,", "so we move when it moves."];
const SAMPLE_SPANS: StyleSpan[] = [
  { line: 0, start: 15, end: 19, style: "emphasis" },  // fast
  { line: 1, start: 6, end: 10, style: "strong" },     // move
  { line: 1, start: 16, end: 24, style: "underline" }, // it moves
];

const LIVE_APPLY_DEBOUNCE_MS = 350;

export function CaptionStyleModal() {
  // The editor mounts fresh per open so all state derives at mount — no
  // stale-buffer flash on reopen, no reset effect.
  if (!captionStyleOpen.value) return null;
  return <CaptionStyleEditor />;
}

function CaptionStyleEditor() {
  const [initial] = useState(effectiveCaptionCss);
  const [text, setText] = useState(initial);
  // Validated at mount: broken stored text shows its error immediately, and
  // an untouched Save click can't re-persist it (Save disables on error).
  const [error, setError] = useState<string | null>(() => {
    const v = validateCaptionCss(initial);
    return v.ok ? null : v.error;
  });
  const [warnings, setWarnings] = useState<string[]>(() => lintCaptionCss(initial));
  // Re-entry guard: while the unsaved-changes dialog is pending, further
  // close requests no-op. (Escape can't reach us then anyway — the escape
  // stack fires only the top popup, which is the dialog.)
  const guardingRef = useRef(false);
  // The buffer, readable from async continuations: the guard dialog doesn't
  // trap focus, so the user can keep typing while it's up — Save must persist
  // what's in the buffer when they choose, not a stale closure.
  const textRef = useRef(initial);
  // Cancel restores THE SHEET IN EFFECT AT MOUNT — an object we hold. Never
  // "re-parse persisted text": in a boot-degraded session that text is
  // invalid and the sheet on screen is stock.
  const sheetAtOpenRef = useRef(getPreviewSheet("look"));
  const lastAppliedRef = useRef<string | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const clearPending = () => {
    if (debounceRef.current !== undefined) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    }
  };

  // A pending debounce firing after unmount would clobber the restored sheet.
  useEffect(() => clearPending, []);

  const update = (next: string) => {
    setText(next);
    textRef.current = next;
    clearPending();
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = undefined;
      const v = validateCaptionCss(next);
      setError(v.ok ? null : v.error);
      setWarnings(lintCaptionCss(next));
      // Live-apply, last-good-wins: the real overlay (and the strip below)
      // track the buffer; invalid states keep the previous good sheet.
      if (v.ok && next !== lastAppliedRef.current) {
        setPreviewSheet("look", v.sheet);
        lastAppliedRef.current = next;
      }
    }, LIVE_APPLY_DEBOUNCE_MS);
  };

  const doSave = (): boolean => {
    const current = textRef.current;
    // Blank buffer means "back to stock" — persist as removal AND apply the
    // stock sheet now (an empty look sheet would leave the overlay bare
    // until restart).
    const applied = isEffectivelyEmpty(current) ? DEFAULT_CAPTION_PREVIEW_CSS : current;
    const v = validateCaptionCss(applied);
    if (!v.ok) {
      // The button's disabled state lags the buffer by the debounce — a Save
      // that lands in that window must surface the error now, not 350ms later.
      clearPending();
      setError(v.error);
      setWarnings(lintCaptionCss(current));
      return false;
    }
    clearPending();
    saveCaptionCss(current);
    setPreviewSheet("look", v.sheet);
    captionStyleOpen.value = false;
    return true;
  };

  const doCancel = () => {
    clearPending();
    setPreviewSheet("look", sheetAtOpenRef.current);
    captionStyleOpen.value = false;
  };

  // X / Escape / click-out: free when clean, guarded when dirty (hand-typed
  // CSS is manager-class data). The explicit Cancel button discards directly.
  // Returns true if the editor closed, false if the user chose to stay.
  const requestClose = async (): Promise<boolean> => {
    // Matches the managers: a dirty close raises OUR prompt even if a
    // foreign one (File ▸ Close Project etc.) is pending — displacement
    // resolves the foreign dialog as cancel, safely (identity-guarded), so
    // e.g. the quit flow keeps moving instead of silently dying here.
    if (guardingRef.current) return false;
    if (textRef.current === initial) {
      doCancel();
      return true;
    }
    guardingRef.current = true;
    try {
      if (validateCaptionCss(textRef.current).ok) {
        const choice = await confirmUnsavedChanges(
          "You have unsaved changes to the caption preview style. Save before closing?",
          { title: "Unsaved style changes" },
        );
        if (choice === "save") return doSave();
        if (choice === "discard") { doCancel(); return true; }
        return false;
      }
      // The buffer can't be saved, so the only choices are stay or discard:
      // hideDiscard drops the middle button and the primary is relabeled
      // Discard (its "save" resolution means discard here).
      const choice = await confirmUnsavedChanges(
        "Your caption CSS has an error and can't be saved. Discard the changes?",
        { title: "Invalid CSS", hideDiscard: true, confirmLabel: "Discard" },
      );
      if (choice === "save") { doCancel(); return true; }
      return false;
    } finally {
      guardingRef.current = false;
    }
  };

  // Register the guarded close for menu actions; refreshed every render so
  // the registered closure is never stale.
  useEffect(() => {
    _requestClose = requestClose;
    return () => { _requestClose = null; };
  });

  useEscapeToClose(true, requestClose);
  const backdropProps = useBackdropClose(requestClose);

  const dirty = text !== initial;

  return (
    <div class="modal-backdrop" {...backdropProps}>
      <div class="caption-style-panel" onClick={(e) => e.stopPropagation()}>
        <div class="fmt-manager-header">
          <span class="fmt-manager-title">Caption Preview Style</span>
          <button class="btn btn-ghost btn-icon" onClick={requestClose}><X size={14} /></button>
        </div>

        <div class="caption-style-body">
          <div class="caption-style-main">
            <textarea
              ref={editorRef}
              class="caption-style-editor"
              spellcheck={false}
              value={text}
              onInput={(e) => update((e.target as HTMLTextAreaElement).value)}
            />
            {(error !== null || warnings.length > 0) && (
              <div class="caption-style-messages">
                {error && <p class="caption-style-error">{error}</p>}
                {!error && warnings.map((w) => <p class="caption-style-warning" key={w}>{w}</p>)}
              </div>
            )}
          </div>
          <div class="caption-style-side">
            <div class="caption-style-preview">
              <div class="caption-overlay">
                <StyledLines
                  lines={SAMPLE_LINES}
                  spans={SAMPLE_SPANS}
                  lineAs="span"
                  lineClass="caption-overlay-line"
                />
              </div>
            </div>
            <p class="caption-style-hint">
              Styles only affect Codfish's caption preview — exports are unchanged.
            </p>
          </div>
        </div>

        <div class="caption-style-footer">
          <button
            class="btn btn-ghost btn-sm"
            onClick={() => {
              update(DEFAULT_CAPTION_PREVIEW_CSS);
              // Keep typing focus in the editor — a reflexive Ctrl+Z after
              // Reset must reach the textarea, not the app's undo fallback.
              editorRef.current?.focus();
            }}
          >
            Reset to default
          </button>
          <div class="caption-style-footer-spacer" />
          <button class="btn btn-ghost btn-sm" onClick={doCancel}>Cancel</button>
          <button class="btn btn-primary btn-sm" onClick={() => doSave()} disabled={!!error || !dirty}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
