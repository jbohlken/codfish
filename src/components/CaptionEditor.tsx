import { useEffect, useRef, useState } from "preact/hooks";
import {
  TextItalicIcon as Italic,
  TextBIcon as Bold,
  TextUnderlineIcon as Underline,
  EraserIcon as Eraser,
} from "@phosphor-icons/react";
import type { SpanStyleKey, StyleSpan } from "../types/project";
import { normalizeSpans, segmentLine } from "../lib/spans";

// Rich caption editor: a contenteditable region whose DOM is treated as
// UNTRUSTED scratch space. The model (lines + spans) is the only source of
// truth — renderInitialHtml projects it into the DOM once on mount, and
// serializeEditor() is the single read path back out, tolerating whatever
// markup shape the engine's editing machinery produces (tags, data-style
// attributes, or inline styles; WebView2 and WKWebView differ here).
// Styling toggles go through execCommand: deprecated-but-frozen, and the only
// approach that keeps native typing, IME composition, selection handling, and
// the engine's own undo stack intact. If an engine misbehaves, the walker
// still serializes its output correctly — worst case a toggle is a no-op.

const TAGS: Record<SpanStyleKey, string> = { emphasis: "i", strong: "b", underline: "u" };

const TAG_TO_STYLE: Record<string, SpanStyleKey | undefined> = {
  I: "emphasis",
  EM: "emphasis",
  B: "strong",
  STRONG: "strong",
  U: "underline",
};

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Project the model into editor HTML: escaped text, styles as real <i>/<b>/<u>
 *  tags (execCommand's toggles understand those), lines joined with <br>. */
export function renderInitialHtml(lines: string[], spans: StyleSpan[]): string {
  const html = lines
    .map((line, i) => {
      const lineSpans = spans.filter((s) => s.line === i);
      return segmentLine(line, lineSpans)
        .map((seg) => {
          let out = escapeHtml(seg.text);
          for (let j = seg.styles.length - 1; j >= 0; j--) {
            const tag = TAGS[seg.styles[j]];
            out = `<${tag}>${out}</${tag}>`;
          }
          return out;
        })
        .join("");
    })
    .join("<br>");
  // A bare <br> keeps an empty editor focusable with a visible caret line.
  return html || "<br>";
}

/** Styles an element adds or removes, from any of the shapes engines emit:
 *  semantic tags, data-style attributes, or inline styles (including negations
 *  like font-weight:normal inside a <b>, which execCommand uses to un-style
 *  part of a styled run). */
function applyElementStyles(el: HTMLElement, active: ReadonlySet<SpanStyleKey>): Set<SpanStyleKey> {
  const next = new Set(active);
  const tagStyle = TAG_TO_STYLE[el.tagName];
  if (tagStyle) next.add(tagStyle);
  const ds = el.getAttribute?.("data-style");
  if (ds === "emphasis" || ds === "strong" || ds === "underline") next.add(ds);

  const st = el.style;
  if (st) {
    if (st.fontStyle === "italic" || st.fontStyle === "oblique") next.add("emphasis");
    else if (st.fontStyle === "normal") next.delete("emphasis");

    const fw = st.fontWeight;
    const fwNum = parseInt(fw, 10);
    if (fw === "bold" || fw === "bolder" || fwNum >= 600) next.add("strong");
    else if (fw === "normal" || fw === "lighter" || (fwNum > 0 && fwNum < 600)) next.delete("strong");

    const td = st.textDecorationLine || st.textDecoration;
    if (td) {
      if (td.includes("underline")) next.add("underline");
      else if (td.includes("none")) next.delete("underline");
    }
  }
  return next;
}

/** Walk the editor DOM back into the model. NBSPs (which contenteditable
 *  inserts for consecutive/trailing spaces) normalize to plain spaces so
 *  caption text stays in the character repertoire the rest of the pipeline
 *  was built against. Output spans are canonical. */
export function serializeEditor(root: HTMLElement): { lines: string[]; spans: StyleSpan[] } {
  const lines: string[] = [];
  const spans: StyleSpan[] = [];
  let currentLine = "";
  let currentLineIdx = 0;
  const open = new Map<SpanStyleKey, number>();

  const flushStyles = (active: ReadonlySet<SpanStyleKey>, offset: number) => {
    for (const [style, start] of Array.from(open)) {
      if (!active.has(style)) {
        if (start < offset) spans.push({ line: currentLineIdx, start, end: offset, style });
        open.delete(style);
      }
    }
    for (const style of active) {
      if (!open.has(style)) open.set(style, offset);
    }
  };

  const finishLine = () => {
    for (const [style, start] of open) {
      if (start < currentLine.length) {
        spans.push({ line: currentLineIdx, start, end: currentLine.length, style });
      }
    }
    open.clear();
    lines.push(currentLine);
    currentLine = "";
    currentLineIdx = lines.length;
  };

  const walk = (node: Node, active: ReadonlySet<SpanStyleKey>) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/\u00a0/g, " ");
      if (text.length === 0) return;
      // In a white-space:pre-wrap contenteditable, Chromium inserts line
      // breaks as literal "\n" TEXT rather than <br> \u2014 a break the model
      // must represent as separate lines, never as an embedded newline
      // (single-line renderers like the timeline label would collapse it).
      const parts = text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) finishLine();
        if (parts[i].length === 0) continue;
        flushStyles(active, currentLine.length);
        currentLine += parts[i];
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.tagName === "BR") {
      finishLine();
      return;
    }
    if (el.tagName === "DIV" || el.tagName === "P") {
      // Engines wrap inserted lines in <div> (or <p>). Treat entering one as
      // an implicit line break when content already accumulated. A div whose
      // only content is a lone <br> is Chromium's EMPTY-line shape — the
      // entering break already represents it, so walking the inner <br> too
      // would double the blank.
      if (currentLine.length > 0 || lines.length > 0) finishLine();
      const kids = Array.from(el.childNodes);
      const loneBr =
        kids.length === 1 &&
        kids[0].nodeType === Node.ELEMENT_NODE &&
        (kids[0] as HTMLElement).tagName === "BR";
      if (loneBr) return;
      for (const child of kids) walk(child, active);
      return;
    }
    const next = applyElementStyles(el, active);
    for (const child of Array.from(el.childNodes)) walk(child, next);
  };

  walk(root, new Set());
  finishLine();
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return { lines, spans: normalizeSpans(lines, spans) };
}

// ── Component ────────────────────────────────────────────────────────────────

export interface CaptionEditorProps {
  initialLines: string[];
  initialSpans: StyleSpan[];
  /** Fires on every edit for live preview; receives the serialized model. */
  onInput: (lines: string[], spans: StyleSpan[]) => void;
  onCommit: (lines: string[], spans: StyleSpan[]) => void;
  onCancel: () => void;
}

type Command = "italic" | "bold" | "underline";

export function CaptionEditor({ initialLines, initialSpans, onInput, onCommit, onCancel }: CaptionEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);
  const [active, setActive] = useState<Record<Command, boolean>>({
    italic: false, bold: false, underline: false,
  });
  // Styling popover: anchored to the current text selection so the editing
  // row keeps the exact height of a non-editing row (a fixed toolbar row
  // would grow it — regressing the 0.6.x row-height fix). null = hidden.
  const [popover, setPopover] = useState<{ left: number; top: number; below: boolean } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = renderInitialHtml(initialLines, initialSpans);
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // caret at end
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    // Prefer tag markup (<b>/<i>/<u>) over style-attribute spans where the
    // engine honors it; the serializer handles both regardless.
    try { document.execCommand("styleWithCSS", false, "false"); } catch { /* optional */ }
  }, []);

  // Selection tracking: button pressed-states follow the caret, and the
  // styling popover shows over any non-collapsed selection in the editor.
  useEffect(() => {
    const update = () => {
      const el = ref.current;
      const wrapper = wrapperRef.current;
      const sel = document.getSelection();
      if (!el || !wrapper || !sel || !el.contains(sel.anchorNode)) {
        setPopover(null);
        return;
      }
      try {
        setActive({
          italic: document.queryCommandState("italic"),
          bold: document.queryCommandState("bold"),
          underline: document.queryCommandState("underline"),
        });
      } catch { /* engine without queryCommandState — states just stay off */ }

      if (sel.isCollapsed || sel.rangeCount === 0 || !el.contains(sel.focusNode)) {
        setPopover(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setPopover(null);
        return;
      }
      // Centered over the selection; flip below it when there's no headroom
      // (rows near the top of the scrolling list would clip the popover).
      const wrapRect = wrapper.getBoundingClientRect();
      const left = Math.max(52, Math.min(rect.left + rect.width / 2 - wrapRect.left, wrapRect.width - 52));
      const below = rect.top - wrapRect.top < 34;
      const top = below ? rect.bottom - wrapRect.top + 6 : rect.top - wrapRect.top - 6;
      setPopover({ left, top, below });
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  const readCurrent = (): { lines: string[]; spans: StyleSpan[] } => {
    const el = ref.current;
    if (!el) return { lines: initialLines, spans: initialSpans };
    return serializeEditor(el);
  };

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    const { lines, spans } = readCurrent();
    onCommit(lines, spans);
  };

  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  };

  const emitInput = () => {
    const { lines, spans } = readCurrent();
    onInput(lines, spans);
  };

  const applyCommand = (cmd: Command | "removeFormat") => {
    ref.current?.focus();
    try { document.execCommand(cmd); } catch { /* unsupported → no-op */ }
    emitInput();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    // IME composition: Enter confirms a conversion and Escape cancels one —
    // neither may commit/close the editor. keyCode 229 covers engines that
    // fire the post-composition key with isComposing already false.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "b" || k === "i" || k === "u") {
        e.preventDefault();
        applyCommand(k === "b" ? "bold" : k === "i" ? "italic" : "underline");
      }
    }
  };

  const toolbarButton = (cmd: Command, label: string, shortcut: string, Icon: typeof Italic) => (
    <button
      type="button"
      class={`btn-caption-toolbar${active[cmd] ? " is-active" : ""}`}
      aria-pressed={active[cmd]}
      data-tooltip={`${label} (${shortcut})`}
      onClick={() => applyCommand(cmd)}
    >
      <Icon size={13} />
    </button>
  );

  return (
    <div class="caption-editor-wrapper" ref={wrapperRef}>
      {popover && (
        /* preventDefault keeps focus+selection in the editable region, which
           also means popover clicks never blur-commit mid-styling. Rendered
           inside the wrapper so the click-outside commit treats it as inside. */
        <div
          class={`caption-editor-popover${popover.below ? " caption-editor-popover--below" : ""}`}
          style={{ left: `${popover.left}px`, top: `${popover.top}px` }}
          role="toolbar"
          aria-label="Text styling"
          onMouseDown={(e) => e.preventDefault()}
        >
          {toolbarButton("italic", "Italic", "Ctrl+I", Italic)}
          {toolbarButton("bold", "Bold", "Ctrl+B", Bold)}
          {toolbarButton("underline", "Underline", "Ctrl+U", Underline)}
          <button
            type="button"
            class="btn-caption-toolbar"
            data-tooltip="Clear styling"
            onClick={() => applyCommand("removeFormat")}
          >
            <Eraser size={13} />
          </button>
        </div>
      )}
      <div
        ref={ref}
        class="caption-editor"
        contenteditable
        spellcheck={true}
        role="textbox"
        aria-multiline="true"
        aria-label="Caption text"
        onKeyDown={handleKeyDown}
        onInput={emitInput}
        onBlur={commit}
        onPaste={(e) => {
          // Paste is always plain text — external markup never enters the model.
          e.preventDefault();
          const text = e.clipboardData?.getData("text/plain") ?? "";
          try { document.execCommand("insertText", false, text); } catch { /* no-op */ }
          emitInput();
        }}
      />
    </div>
  );
}
