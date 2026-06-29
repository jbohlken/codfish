import { useEffect, useRef } from "preact/hooks";
import { signal, useSignalEffect } from "@preact/signals";
import { PanelResizeHandle } from "./PanelResizeHandle";
import {
  selectedMedia,
  selectedMediaId,
  selectedCaptionIndex,
  playbackTime,
  revealCaptionTick,
  project,
  activeProfile,
  pushHistory,
  beginPendingAdd,
  commitPendingAdd,
  cancelPendingAdd,
  getPendingAddIndex,
  mediaDuration,
  isPlaying,
  playingCaptionIndex,
  warningsByCaption,
  isBatchRunning,
} from "../../store/app";
import { snapToFrame, breakTextIntoLines } from "../../lib/pipeline";
import { getClipView } from "../../lib/clipView";
import { framesBetween } from "../../lib/time";
import { formatDisplayTime } from "../../lib/time";
import { PlusIcon as Plus, PencilSimpleIcon as PencilSimple, ScissorsIcon as Scissors, ArrowsMergeIcon as ArrowsMerge, XIcon as X, InfoIcon as Info, WarningIcon as Warning, MagnifyingGlassIcon as MagnifyingGlass, SwapIcon as Swap, TextAaIcon as TextAa, RepeatOnceIcon as RepeatOnce, RepeatIcon as Repeat, DotsThreeVerticalIcon as DotsThreeVertical, SquareIcon as Square, CheckSquareIcon as CheckSquare } from "@phosphor-icons/react";
import type { ValidationWarning } from "../../lib/pipeline/types";
import { CaptionNumber } from "../CaptionNumber";
import { captionMatches, replaceInLines, splitOnMatches } from "../../lib/captionSearch";
import { contextMenu, openContextMenu, closeContextMenu } from "../ContextMenu";
import { TOOLTIP_DIVIDER } from "../Tooltip";
import { generateSelectedMedia } from "../../lib/actions";
import { isUpdating } from "../UpdateNotice";
import type { CaptionBlock, TranscriptionModel } from "../../types/project";

// ── Panel-local state ─────────────────────────────────────────────────────────
const editingIndex = signal<number | null>(null);
const editText = signal("");
export { editingIndex, editText };

// Flag to suppress onBlur commit when Escape is pressed in the textarea
let _editCancelled = false;

// ── Search / find-and-replace ───────────────────────────────────────────────
// Module-level. Typing DIMS the non-matching captions (the list is never
// filtered, so it stays congruent with the always-unfiltered timeline) and
// highlights matches; the replace controls act on the current / all matches.
// A "match" is a caption whose text contains the query.
const searchOpen = signal(false);
const replaceOpen = signal(false); // the replace row is a popped-open second line
const findText = signal("");
const replaceText = signal("");
// Match-case is a persisted preference (like followPlayhead), not transient state.
const caseSensitive = signal(localStorage.getItem("codfish:captionSearchCaseSensitive") === "true");
// When on, the Replace action (button + Enter) replaces across all matches rather
// than just the selected one. Persisted preference (default off — the safer non-bulk action).
const replaceAllMode = signal(localStorage.getItem("codfish:captionSearchReplaceAll") === "true");

function openCaptionSearch() {
  searchOpen.value = true;
}
// Closing keeps the find/replace text and the replace-row state, so the query
// carries across close→reopen AND across clip switches (one shared query) within
// a session; only the clear-X empties it.
function closeCaptionSearch() {
  searchOpen.value = false;
}

// Reactive checkbox icon for the "Replace all" options-menu toggle — reads the
// signal so it flips live while the kept-open menu stays on screen.
function ReplaceAllCheck() {
  return replaceAllMode.value ? <CheckSquare size={14} /> : <Square size={14} />;
}

// Ordered caption indices whose text contains the current query.
function matchingIndices(): number[] {
  const media = selectedMedia.peek();
  const q = findText.peek().trim();
  if (!media || !q) return [];
  const cs = caseSensitive.peek();
  return media.captions
    .filter((c) => captionMatches(c.lines.join("\n"), q, cs))
    .map((c) => c.index);
}

// Select a match and bring it into view, pausing playback + seeking so
// followPlayhead can't override the selection. Mirrors a caption row click.
function selectMatch(index: number) {
  const block = selectedMedia.peek()?.captions.find((c) => c.index === index);
  if (!block) return;
  isPlaying.value = false;
  editingIndex.value = null;
  selectedCaptionIndex.value = index;
  playbackTime.value = block.start;
  revealCaptionTick.value++;
}

// Step to the next (+1) or previous (-1) matching caption, wrapping around. If
// the current selection isn't a match, +1 → first, -1 → last.
function gotoMatch(dir: 1 | -1) {
  const matches = matchingIndices();
  if (!matches.length) return;
  const cur = selectedCaptionIndex.peek();
  const at = cur == null ? -1 : matches.indexOf(cur);
  const next = at < 0
    ? (dir === 1 ? 0 : matches.length - 1)
    : (at + dir + matches.length) % matches.length;
  selectMatch(matches[next]);
}

function replaceLabel(query: string, count: number): string {
  return count > 1 ? `Replace "${query}" (${count})` : `Replace "${query}"`;
}

// Replace within the selected caption (if it's a match), then settle on the
// match now occupying its slot — the next one, since this caption drops out.
function replaceInSelected() {
  const proj = project.peek();
  const media = selectedMedia.peek();
  const q = findText.peek().trim();
  if (!proj || !media || !q) return;
  const idx = selectedCaptionIndex.peek();
  if (idx == null) return;
  const at = matchingIndices().indexOf(idx);
  if (at < 0) return; // selection isn't a match
  const cs = caseSensitive.peek();
  const block = media.captions.find((c) => c.index === idx)!;
  const newLines = replaceInLines(block.lines, q, replaceText.peek(), cs);
  pushHistory({
    ...proj,
    media: proj.media.map((m) =>
      m.id !== media.id ? m : {
        ...m,
        captions: m.captions.map((c) => (c.index !== idx ? c : { ...c, lines: newLines, edited: true })),
      }),
  }, replaceLabel(q, 1));
  const after = matchingIndices();
  if (after.length) selectMatch(after[Math.min(at, after.length - 1)]);
}

// Replace every occurrence across all matching captions in one undoable step.
function replaceInAll() {
  const proj = project.peek();
  const media = selectedMedia.peek();
  const q = findText.peek().trim();
  if (!proj || !media || !q) return;
  const cs = caseSensitive.peek();
  const repl = replaceText.peek();
  let count = 0;
  const captions = media.captions.map((c) => {
    if (!captionMatches(c.lines.join("\n"), q, cs)) return c;
    count++;
    return { ...c, lines: replaceInLines(c.lines, q, repl, cs), edited: true };
  });
  if (!count) return;
  pushHistory({
    ...proj,
    media: proj.media.map((m) => (m.id !== media.id ? m : { ...m, captions })),
  }, replaceLabel(q, count));
}

// ── Caption operations ────────────────────────────────────────────────────────

function deleteCaption(index: number) {
  const proj = project.value;
  const media = selectedMedia.value;
  if (!proj || !media) return;

  const pos = media.captions.findIndex((c) => c.index === index);
  if (pos < 0) return;
  const newCaptions = media.captions
    .filter((c) => c.index !== index)
    .map((c, i) => ({ ...c, index: i + 1 }));

  const next = newCaptions[pos] ?? newCaptions[pos - 1] ?? null;

  // Push while selection still points at the deleted caption so undo lands
  // there; pass the neighbor as post-op selection so redo settles naturally.
  pushHistory({
    ...proj,
    media: proj.media.map((m) =>
      m.id !== media.id ? m : { ...m, captions: newCaptions }
    ),
  }, "Delete caption", {
    selectedMediaId: selectedMediaId.value,
    selectedCaptionIndex: next?.index ?? null,
  });

  selectedCaptionIndex.value = next?.index ?? null;
}

function splitCaption(index: number) {
  const proj = project.value;
  const media = selectedMedia.value;
  if (!proj || !media) return;

  const block = media.captions.find((c) => c.index === index);
  if (!block) return;

  const t = playbackTime.value;
  // Allow t === block.start (playhead landed exactly on the start, e.g. just
  // after clicking a block to seek). Downstream snap logic shifts the split
  // point to block.start + 1/fps in that case.
  if (t < block.start || t >= block.end) return;

  const fps = media.fps ?? activeProfile.value.timing.defaultFps;

  // Caption must be at least 2 frames long to produce two non-empty halves.
  const totalFrames = framesBetween(block.start, block.end, fps);
  if (totalFrames < 2) return;

  // Splitting a single-word caption would always leave one half empty.
  const wordCount = block.lines.join(" ").trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 2) return;

  // Snap to nearest frame, then round inward if we landed on a boundary so
  // both halves are guaranteed to be at least 1 frame long.
  let splitPoint = snapToFrame(t, fps);
  const leftFrames = framesBetween(block.start, splitPoint, fps);
  if (leftFrames < 1) {
    splitPoint = snapToFrame(block.start + 1 / fps, fps);
  } else if (leftFrames >= totalFrames) {
    splitPoint = snapToFrame(block.end - 1 / fps, fps);
  }

  const profile = activeProfile.value;
  const maxCharsPerLine = profile.formatting.maxCharsPerLine.value;
  const maxLines = profile.formatting.maxLines.value;

  // Text is the source of truth — the user sees block.lines and expects the
  // split to divide exactly those words, never lose or duplicate any. rawWords
  // are consulted only to pick a timing-aware split index when they align 1:1
  // with the displayed tokens; otherwise fall back to a proportional ratio.
  const textTokens = block.lines.join(" ").split(/\s+/).filter(Boolean);
  const wordsInBlock = block.edited
    ? []
    : media.rawWords?.filter((w) => {
        const mid = (w.start + w.end) / 2;
        return mid >= block.start && mid <= block.end;
      }) ?? [];

  // Timing-aware path requires rawWords to align with displayed tokens in
  // both count AND content — matching counts alone could be coincidental if
  // something mutated block.lines without flipping edited=true.
  const tokensAlign =
    wordsInBlock.length === textTokens.length &&
    wordsInBlock.map((w) => w.text).join(" ") === textTokens.join(" ");

  let splitIdx: number;
  if (tokensAlign) {
    const firstAfter = wordsInBlock.findIndex((w) => (w.start + w.end) / 2 >= splitPoint);
    splitIdx = firstAfter < 0 ? textTokens.length - 1 : firstAfter;
  } else {
    const ratio = (splitPoint - block.start) / (block.end - block.start);
    splitIdx = Math.round(textTokens.length * ratio);
  }
  splitIdx = Math.max(1, Math.min(textTokens.length - 1, splitIdx));

  const linesA = breakTextIntoLines(textTokens.slice(0, splitIdx).join(" "), maxCharsPerLine, maxLines);
  const linesB = breakTextIntoLines(textTokens.slice(splitIdx).join(" "), maxCharsPerLine, maxLines);

  const blockA: CaptionBlock = { ...block, end: splitPoint, lines: linesA };
  const blockB: CaptionBlock = { ...block, start: splitPoint, lines: linesB };

  const newCaptions = [
    ...media.captions.filter((c) => c.index < index),
    blockA,
    blockB,
    ...media.captions.filter((c) => c.index > index),
  ].map((c, i) => ({ ...c, index: i + 1 }));

  pushHistory({
    ...proj,
    media: proj.media.map((m) =>
      m.id !== media.id ? m : { ...m, captions: newCaptions }
    ),
  }, "Split caption");

  selectedCaptionIndex.value = index;
}

function mergeCaption(index: number) {
  const proj = project.value;
  const media = selectedMedia.value;
  if (!proj || !media) return;

  const pos = media.captions.findIndex((c) => c.index === index);
  if (pos < 0 || pos >= media.captions.length - 1) return;

  const blockA = media.captions[pos];
  const blockB = media.captions[pos + 1];

  const speaker = blockA.speaker === blockB.speaker ? blockA.speaker : undefined;

  const profile = activeProfile.value;
  const maxCharsPerLine = profile.formatting.maxCharsPerLine.value;
  const maxLines = profile.formatting.maxLines.value;

  // Text is the source of truth — concatenate the displayed lines and wrap.
  // rawWords would produce the same result via a more fragile route and can
  // silently drop or pull in neighbor words when midpoints disagree.
  const combined = [...blockA.lines, ...blockB.lines].join(" ").trim();
  const mergedLines = combined.length > 0
    ? breakTextIntoLines(combined, maxCharsPerLine, maxLines)
    : [""];

  const eitherEdited = blockA.edited || blockB.edited;
  const merged: CaptionBlock = {
    index: 0,
    start: blockA.start,
    end: blockB.end,
    lines: mergedLines,
    speaker,
    ...(eitherEdited ? { edited: true } : {}),
  };

  const newCaptions = [
    ...media.captions.slice(0, pos),
    merged,
    ...media.captions.slice(pos + 2),
  ].map((c, i) => ({ ...c, index: i + 1 }));

  pushHistory({
    ...proj,
    media: proj.media.map((m) =>
      m.id !== media.id ? m : { ...m, captions: newCaptions }
    ),
  }, "Merge captions");

  selectedCaptionIndex.value = pos + 1;
}

function addCaption() {
  const proj = project.value;
  const media = selectedMedia.value;
  if (!proj || !media) return;

  const fps = media.fps ?? activeProfile.value.timing.defaultFps;
  const start = snapToFrame(playbackTime.value, fps);

  // Can't add inside an existing caption. Check on the snapped start, not the
  // raw playhead — snapping can round into a caption if its end isn't frame-
  // aligned (possible with imports / pre-frame-snap project files).
  if (media.captions.some((c) => start >= c.start && start < c.end)) return;

  const nextCaption = media.captions.find((c) => c.start > start);
  const maxEnd = nextCaption?.start ?? mediaDuration.value ?? Infinity;
  const end = snapToFrame(Math.min(start + 2, maxEnd), fps);

  if (end <= start) return;

  const insertPos = media.captions.filter((c) => c.end <= start).length;

  const newBlock: CaptionBlock = {
    index: 0,
    start,
    end,
    lines: [""],
    edited: true,
  };

  const newCaptions = [
    ...media.captions.slice(0, insertPos),
    newBlock,
    ...media.captions.slice(insertPos),
  ].map((c, i) => ({ ...c, index: i + 1 }));

  const newIndex = insertPos + 1;

  // Tentatively add to project state only — no history entry until the user
  // commits non-empty text. Escape / empty commit reverts cleanly via
  // cancelPendingAdd, so history never accumulates Add+Delete phantom pairs.
  beginPendingAdd({
    ...proj,
    media: proj.media.map((m) =>
      m.id !== media.id ? m : { ...m, captions: newCaptions }
    ),
  }, newIndex);

  _editCancelled = false;
  selectedCaptionIndex.value = newIndex;
  editingIndex.value = newIndex;
  editText.value = "";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CaptionPanel() {
  // Caption keyboard shortcuts (Edit, Delete, Split, Add)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement ||
        e.target instanceof HTMLTextAreaElement
      ) return;
      // Blockers (update / batch generation) inert the app-shell but not
      // document-level listeners; gate explicitly so single-letter shortcuts
      // can't reach through the blocker.
      if (isBatchRunning.value || isUpdating()) return;
      if (!selectedMedia.value) return;
      if (editingIndex.value !== null) return;

      const idx = selectedCaptionIndex.value;

      if ((e.key === "Delete" || e.key === "Backspace") && idx !== null && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        deleteCaption(idx);
      } else if (e.key === "s" && !e.ctrlKey && !e.metaKey && idx !== null) {
        e.preventDefault();
        splitCaption(idx);
      } else if (e.key === "m" && !e.ctrlKey && !e.metaKey && idx !== null) {
        e.preventDefault();
        mergeCaption(idx);
      } else if (e.key === "a" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        addCaption();
      } else if (e.key === "Escape" && idx !== null) {
        e.preventDefault();
        selectedCaptionIndex.value = null;
      } else if (e.key === "e" && !e.ctrlKey && !e.metaKey && idx !== null) {
        e.preventDefault();
        const block = selectedMedia.value?.captions.find((c) => c.index === idx);
        if (block) {
          isPlaying.value = false;
          editingIndex.value = idx;
          editText.value = block.lines.join("\n");
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Auto-scroll selected caption into view
  const selectedIdx = selectedCaptionIndex.value;
  useEffect(() => {
    if (selectedIdx == null) return;
    document.querySelector(`[data-caption-index="${selectedIdx}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedIdx]);

  // Auto-scroll to playing caption during playback (only when caption changes)
  const lastPlayingScrollRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useSignalEffect(() => {
    const time = playbackTime.value;
    const media = selectedMedia.value;
    if (!media) return;
    const playing = media.captions.find((c) => time >= c.start && time < c.end);
    const idx = playing?.index ?? null;
    if (idx === lastPlayingScrollRef.current) return;
    lastPlayingScrollRef.current = idx;
    if (idx !== null) {
      document.querySelector(`[data-caption-index="${idx}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });

  // On a clip switch, re-anchor the caption list to where you were in this clip:
  // the remembered selected caption if any, otherwise the caption at (or nearest
  // before) the restored playhead — so a clip left mid-scrub, even with the
  // playhead in a gap and nothing selected, returns near that spot instead of
  // jumping to the top. Only a clip with no captions falls through to the top.
  // The playhead is read from the saved view state (not the live signal, which
  // VideoPanel restores post-render) so there's no ordering race. Keying on media
  // id also re-anchors when two clips share the selected index, which the
  // value-keyed effect above would skip. (Re-arms the playback auto-scroll too.)
  const scrolledMediaId = selectedMedia.value?.id ?? null;
  useEffect(() => {
    lastPlayingScrollRef.current = null;
    const caps = selectedMedia.peek()?.captions ?? [];
    let anchor = selectedCaptionIndex.peek();
    if (anchor == null && caps.length) {
      const t = getClipView(scrolledMediaId ?? undefined)?.playbackTime ?? 0;
      let nearest = caps[0];
      for (const c of caps) {
        if (c.start <= t) nearest = c;
        else break;
      }
      anchor = nearest.index;
    }
    if (anchor != null) {
      document.querySelector(`[data-caption-index="${anchor}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [scrolledMediaId]);

  const media = selectedMedia.value;
  const hasCaptions = (media?.captions.length ?? 0) > 0;
  // Word-level alignment failed during generation (sentence-level timing) — the
  // generation-status badge escalates to a warning when this is set.
  const alignmentDegraded = !!media?.alignmentDegraded;
  // Undefined = unprobed (old projects) or probe failed — allow the attempt.
  // Only block when we explicitly know there's no audio stream.
  const canGenerate = media?.hasAudio ?? true;
  // Subscribes only to caption-boundary crossings, not every rAF tick.
  // Per-row "playhead inside this caption" derives from the same index.
  const playingIndex = playingCaptionIndex.value;
  const canAddCaption = playingIndex === null;

  const profile = activeProfile.value;
  const fps = media?.fps ?? profile.timing.defaultFps;
  const warningsByIndex = warningsByCaption.value;

  // Search / find-and-replace derived state. The list renders ALL captions; an
  // active query just dims the non-matches (decided per row) and highlights the
  // matches — the list is never filtered, so it stays congruent with the timeline.
  // matchIndices drives the count and ◀▶ / Enter navigation.
  const searching = searchOpen.value;
  const query = searching ? findText.value.trim() : "";
  const caseOn = caseSensitive.value;
  const matchIndices = query
    ? (media?.captions ?? [])
        .filter((c) => captionMatches(c.lines.join("\n"), query, caseOn))
        .map((c) => c.index)
    : [];
  const matchTotal = matchIndices.length;
  const curMatchPos = query ? matchIndices.indexOf(selectedCaptionIndex.value ?? -1) : -1;

  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // Focus + select the field when its section opens (find on search-open, replace
  // on replace-open) so a retained query can be overtyped immediately. Deferred a
  // frame so it lands after the drawer is un-inerted and laid out.
  useSignalEffect(() => {
    if (!searchOpen.value) return;
    requestAnimationFrame(() => { const el = findInputRef.current; if (el) { el.focus(); el.select(); } });
  });
  useSignalEffect(() => {
    if (!replaceOpen.value) return;
    requestAnimationFrame(() => { const el = replaceInputRef.current; if (el) { el.focus(); el.select(); } });
  });

  // Keep a match selected as the query/case changes so Replace and the counter
  // have a current target. Light (no seek) so typing doesn't scrub the video —
  // only explicit navigation (Enter / Shift+Enter) moves the playhead.
  useSignalEffect(() => {
    if (!searchOpen.value) return;
    const q = findText.value.trim();
    // peek: re-select only when the query/case changes, not on every project edit
    // (which would teleport selection away from a caption you just finished editing).
    const m = selectedMedia.peek();
    if (!q || !m) return;
    const cs = caseSensitive.value;
    const matches = m.captions
      .filter((c) => captionMatches(c.lines.join("\n"), q, cs))
      .map((c) => c.index);
    const cur = selectedCaptionIndex.peek();
    if (matches.length && !(cur != null && matches.includes(cur))) {
      selectedCaptionIndex.value = matches[0];
    }
  });

  // Close the drawer on a clip switch but KEEP the query — it carries across clips.
  useEffect(() => { closeCaptionSearch(); }, [scrolledMediaId]);

  return (
    <div class="panel caption-panel">
      <div class="panel-header">
        <div class="panel-header-title-group">
          <span class="panel-header-title">Captions</span>
          {/* One non-interactive caption-generation-status badge, revealing its
              detail on hover. Neutral ⓘ when generated cleanly; escalates to an
              amber ⚠ when word-level alignment degraded (its tooltip then leads
              with the warning). Same muted indicator language as the timeline
              fps/VFR badge. Alignment degradation only ever occurs during
              generation, so a degraded badge always also carries the metadata. */}
          {media && hasCaptions && (media.generatedAt || alignmentDegraded) && (
            <span
              class={`caption-meta-badge${alignmentDegraded ? " caption-meta-badge--warning" : ""}`}
              data-tooltip={[
                alignmentDegraded && "Word-level alignment failed for this media.\nCaptions are using sentence-level timing — try regenerating.",
                media.generatedAt && `${formatGenerationMeta(media.generatedWithModel, media.generatedWithLanguage, media.detectedLanguage)}\n${formatFullTimestamp(media.generatedAt)}`,
              ].filter(Boolean).join(`\n${TOOLTIP_DIVIDER}\n`)}
            >
              {alignmentDegraded ? <Warning size={13} /> : <Info size={13} />}
            </span>
          )}
        </div>
        {media && (
          <div style="display:flex;align-items:center;gap:2px">
            {hasCaptions && (searchOpen.value || editingIndex.value === null) && (
              <button
                class={`btn btn-ghost btn-icon${searchOpen.value ? " is-active" : ""}`}
                data-tooltip="Find & replace"
                aria-pressed={searchOpen.value}
                onClick={() => (searchOpen.value ? closeCaptionSearch() : openCaptionSearch())}
              >
                <MagnifyingGlass size={14} />
              </button>
            )}
            <button
              class="btn btn-ghost btn-icon"
              disabled={!canAddCaption}
              data-tooltip={canAddCaption ? "Add caption at playhead (A)" : "Playhead is inside an existing caption"}
              onClick={addCaption}
            >
              <Plus size={14} />
            </button>
          </div>
        )}
        {/* Right-docked panel: handle sits on the header's left edge; dragging
            left widens it. Mirrors the project panel (left-docked, right edge). */}
        <PanelResizeHandle
          cssVar="--caption-panel-width"
          storageKey="codfish:captionPanelWidth"
          edge="left"
        />
      </div>

      {/* Search/replace drawer — slides open below the header (grid 0fr→1fr,
          animating to the content's natural height). Always mounted when there
          are captions so the open/close transition can run; inert while closed
          so its clipped inputs stay out of the tab order. */}
      {media && hasCaptions && (
        <div
          class={`search-drawer${searchOpen.value ? " is-open" : ""}`}
          {...(searchOpen.value ? {} : { inert: true })}
        >
          <div class="search-clip">
            <div class="search-bar">
              <div class="search-row">
                <div class="search-field">
                  <input
                    ref={findInputRef}
                    class="panel-filter-input"
                    type="text"
                    placeholder="Find in captions…"
                    value={findText.value}
                    onInput={(e) => { findText.value = (e.target as HTMLInputElement).value; }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { e.preventDefault(); closeCaptionSearch(); }
                      else if (e.key === "Enter") { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); }
                    }}
                  />
                  {query && (
                    <span class="search-count">
                      {curMatchPos >= 0 ? `${curMatchPos + 1}/${matchTotal}` : `${matchTotal}`}
                    </span>
                  )}
                  {findText.value && (
                    <button class="panel-filter-clear" data-tooltip="Clear" onClick={() => { findText.value = ""; findInputRef.current?.focus(); }}>
                      <X size={12} />
                    </button>
                  )}
                </div>
                <div class="search-tools">
                  <button
                    class={`btn btn-ghost btn-icon${caseOn ? " is-active" : ""}`}
                    data-tooltip="Match case"
                    aria-pressed={caseOn}
                    onClick={() => {
                      const next = !caseOn;
                      caseSensitive.value = next;
                      localStorage.setItem("codfish:captionSearchCaseSensitive", String(next));
                    }}
                  >
                    <TextAa size={14} />
                  </button>
                  <button
                    class={`btn btn-ghost btn-icon${replaceOpen.value ? " is-active" : ""}`}
                    data-tooltip="Replace…"
                    aria-pressed={replaceOpen.value}
                    onClick={() => {
                      const next = !replaceOpen.value;
                      replaceOpen.value = next;
                      if (!next) {
                        // Back to searching: focus Find with the caret at the end. focus()
                        // alone restores whatever range the field last had, which is why it
                        // sometimes re-selected the text and sometimes didn't.
                        const el = findInputRef.current;
                        if (el) { el.focus(); const n = el.value.length; el.setSelectionRange(n, n); }
                      }
                    }}
                  >
                    <Swap size={14} />
                  </button>
                </div>
              </div>
              <div
                class={`caption-replace-drawer${replaceOpen.value ? " is-open" : ""}`}
                {...(replaceOpen.value ? {} : { inert: true })}
              >
                <div class="caption-replace-clip">
                  <div class="search-row">
                    <div class="search-field">
                      <input
                        ref={replaceInputRef}
                        class="panel-filter-input"
                        type="text"
                        placeholder="Replace with…"
                        value={replaceText.value}
                        onInput={(e) => { replaceText.value = (e.target as HTMLInputElement).value; }}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") { e.preventDefault(); closeCaptionSearch(); }
                          else if (e.key === "Enter") { e.preventDefault(); if (replaceAllMode.value) replaceInAll(); else replaceInSelected(); }
                        }}
                      />
                      {replaceText.value && (
                        <button class="panel-filter-clear" data-tooltip="Clear" onClick={() => { replaceText.value = ""; replaceInputRef.current?.focus(); }}>
                          <X size={12} />
                        </button>
                      )}
                    </div>
                    <div class="search-tools">
                      <button
                        class="btn btn-ghost btn-icon"
                        data-tooltip={replaceAllMode.value ? "Replace all (Enter)" : "Replace (Enter)"}
                        disabled={replaceAllMode.value ? matchTotal === 0 : curMatchPos < 0}
                        onClick={() => { if (replaceAllMode.value) replaceInAll(); else replaceInSelected(); }}
                      >
                        {replaceAllMode.value ? <Repeat size={14} /> : <RepeatOnce size={14} />}
                      </button>
                      <button
                        class={`btn btn-ghost btn-icon${contextMenu.value?.source === "caption-replace-options" ? " is-active" : ""}`}
                        data-tooltip="Replace options"
                        // Stop our own mousedown reaching the menu's outside-click close, so
                        // a second click toggles the menu shut instead of close-then-reopen.
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (contextMenu.value?.source === "caption-replace-options") { closeContextMenu(); return; }
                          // Anchor the menu to the button (open below it) rather than the
                          // click point, so it behaves like a dropdown.
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          openContextMenu(r.left, r.bottom + 4, [
                            {
                              label: "Replace all matches",
                              keepOpen: true,
                              icon: <ReplaceAllCheck />,
                              onClick: () => {
                                const next = !replaceAllMode.peek();
                                replaceAllMode.value = next;
                                localStorage.setItem("codfish:captionSearchReplaceAll", String(next));
                              },
                            },
                            { separator: true },
                            // Placeholder for a future "save this find/replace as a reusable rule" feature.
                            { label: "Create rule…", disabled: true },
                          ], "caption-replace-options");
                        }}
                      >
                        <DotsThreeVertical size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div class="panel-body scrollable" ref={listRef}>
        {!media ? (
          <div class="empty-state">
            <span class="empty-state-body">Select a media item to view captions.</span>
          </div>
        ) : media.captions.length === 0 ? (
          <div class="empty-state">
            <span class="empty-state-title">No captions yet</span>
            {!canGenerate ? (
              <span class="empty-state-body">This media has no audio track.</span>
            ) : (
              <button class="btn btn-primary btn-sm" onClick={generateSelectedMedia}>
                Generate
              </button>
            )}
          </div>
        ) : (
          <div class="caption-list" onClick={(e) => { if (!(e.target as HTMLElement).closest(".caption-row")) selectedCaptionIndex.value = null; }}>
            {/* A click that misses every row (padding, the filler below the last
                row) clears the selection — row clicks select and stop here by
                hitting .caption-row first. Mirrors the project panel's idiom. An
                active query dims non-matching rows rather than hiding them. */}
            {media.captions.map((block) => (
              <CaptionRow
                key={block.index}
                block={block}
                fps={fps}
                query={query}
                caseSensitive={caseOn}
                selected={selectedCaptionIndex.value === block.index}
                playing={playingIndex === block.index}
                editing={editingIndex.value === block.index}
                warnings={warningsByIndex.get(block.index) ?? []}
                splitEnabled={
                  playingIndex === block.index &&
                  framesBetween(block.start, block.end, fps) >= 2 &&
                  block.lines.join(" ").trim().split(/\s+/).filter(Boolean).length >= 2
                }
                splitTooltip={
                  // Playhead-outside takes priority — it's the actionable hint.
                  // Only after the playhead is inside do the structural reasons
                  // (single-word, too-short) become relevant.
                  playingIndex !== block.index
                    ? "Position playhead inside this caption to split"
                    : block.lines.join(" ").trim().split(/\s+/).filter(Boolean).length < 2
                      ? "Can't split a single-word caption"
                      : framesBetween(block.start, block.end, fps) < 2
                        ? "Caption too short to split"
                        : "Split at playhead (S)"
                }
                mergeEnabled={block.index < media.captions.length}
                onMouseDown={() => {
                  if (editingIndex.value !== null && editingIndex.value !== block.index) {
                    handleEdit(editingIndex.value, editText.value);
                  }
                }}
                onClick={() => {
                  editingIndex.value = null;
                  selectedCaptionIndex.value = block.index;
                  playbackTime.value = block.start;
                  revealCaptionTick.value++; // reveal in the timeline, even if already active
                }}
                onDblClick={() => {
                  selectedCaptionIndex.value = block.index;
                  isPlaying.value = false;
                  editingIndex.value = block.index;
                  editText.value = block.lines.join("\n");
                }}
                onEdit={(text) => handleEdit(block.index, text)}
                onSplit={() => splitCaption(block.index)}
                onMerge={() => mergeCaption(block.index)}
                onDelete={() => deleteCaption(block.index)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Caption row ───────────────────────────────────────────────────────────────

// Editing a caption is also available by double-clicking its row, so the inline
// Edit button is hidden for now. Flip to true to bring it back.
const SHOW_CAPTION_EDIT_BUTTON = false;

function CaptionRow({
  block,
  fps,
  selected,
  playing,
  editing,
  warnings,
  query,
  caseSensitive,
  splitEnabled,
  splitTooltip,
  mergeEnabled,
  onMouseDown,
  onClick,
  onDblClick,
  onEdit,
  onSplit,
  onMerge,
  onDelete,
}: {
  block: CaptionBlock;
  fps: number;
  selected: boolean;
  playing: boolean;
  editing: boolean;
  warnings: ValidationWarning[];
  query: string;
  caseSensitive: boolean;
  splitEnabled: boolean;
  splitTooltip: string;
  mergeEnabled: boolean;
  onMouseDown: () => void;
  onClick: () => void;
  onDblClick: () => void;
  onEdit: (text: string) => void;
  onSplit: () => void;
  onMerge: () => void;
  onDelete: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  // Click-outside commit: native blur only fires when focus moves to another
  // focusable element. Clicks on non-focusable areas (video panel, timeline
  // body, empty list space) would otherwise leave the editor open. The row's
  // own mousedown handler runs first (bubble phase) and may have already
  // committed for row-to-row clicks, so guard against double-commit.
  useEffect(() => {
    if (!editing) return;
    const handler = (e: MouseEvent) => {
      if (editingIndex.value !== block.index) return;
      const target = e.target as Node | null;
      if (target && textareaRef.current && !textareaRef.current.contains(target)) {
        onEdit(editText.value);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editing, onEdit, block.index]);

  if (editing) {
    return (
      <div class="caption-row caption-row--selected" data-caption-index={block.index}>
        <div class="caption-row-meta"><CaptionNumber index={block.index} warnings={warnings} /> · {formatDisplayTime(block.start, "time", fps, true)} → {formatDisplayTime(block.end, "time", fps, true)}</div>
        <textarea
          ref={textareaRef}
          class="caption-row-editor"
          value={editText.value}
          onInput={(e) => { editText.value = e.currentTarget.value; }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              _editCancelled = true;
              editingIndex.value = null;
              if (getPendingAddIndex() === block.index) {
                // A-then-Escape: roll back the tentative add entirely.
                cancelPendingAdd();
              } else if (!block.lines.join("").trim()) {
                onDelete();
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onEdit(editText.value);
            }
          }}
          onBlur={() => {
            if (_editCancelled) { _editCancelled = false; return; }
            onEdit(editText.value);
          }}
          rows={2}
          autoFocus
        />
      </div>
    );
  }


  const text = block.lines.join("\n");
  const segments = query ? splitOnMatches(text, query, caseSensitive) : null;
  const isMatch = !!segments?.some((s) => s.isMatch);
  // Dim non-matching rows while a query is active (the list is never filtered);
  // the selected/playing row stays full-strength so the active caption reads.
  const dimmed = query !== "" && !isMatch && !selected && !playing;

  return (
    <div
      class={`caption-row${selected ? " caption-row--selected" : ""}${playing ? " caption-row--playing" : ""}${dimmed ? " caption-row--dimmed" : ""}`}
      data-caption-index={block.index}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onDblClick={onDblClick}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onClick(); }}
    >
      <div class="caption-row-meta">
        <CaptionNumber index={block.index} warnings={warnings} /> · {formatDisplayTime(block.start, "time", fps, true)} → {formatDisplayTime(block.end, "time", fps, true)}
      </div>
      <div class="caption-row-text">
        {segments
          ? segments.map((seg, i) =>
              seg.isMatch ? <mark key={i} class="search-match">{seg.text}</mark> : seg.text)
          : text}
      </div>
      {selected && (
        <div class="caption-row-actions" onClick={(e) => e.stopPropagation()}>
          {SHOW_CAPTION_EDIT_BUTTON && (
            <button
              class="btn-caption-action"
              data-tooltip="Edit (E)"
              onClick={() => {
                isPlaying.value = false;
                editingIndex.value = block.index;
                editText.value = block.lines.join("\n");
              }}
            >
              <PencilSimple size={14} />
            </button>
          )}
          <button
            class="btn-caption-action"
            disabled={!splitEnabled}
            data-tooltip={splitTooltip}
            onClick={onSplit}
          >
            <Scissors size={14} />
          </button>
          <button
            class="btn-caption-action"
            disabled={!mergeEnabled}
            data-tooltip={mergeEnabled ? "Merge with next (M)" : "No next caption to merge with"}
            onClick={onMerge}
          >
            <ArrowsMerge size={14} />
          </button>
          <button
            class="btn-caption-action btn-caption-action--delete"
            data-tooltip="Delete (Delete)"
            onClick={onDelete}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const LANGUAGE_LABELS: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French",
  de: "German", ja: "Japanese", zh: "Chinese",
};

const MODEL_LABELS: Record<string, string> = {
  tiny: "Tiny", base: "Base", small: "Small",
  medium: "Medium", "large-v3": "Large v3",
};

function formatGenerationMeta(
  model: TranscriptionModel | undefined,
  generatedWithLanguage: string | undefined,
  detectedLanguage: string | undefined,
): string {
  const parts: string[] = [];
  if (model) parts.push(MODEL_LABELS[model] ?? model);
  if (generatedWithLanguage) {
    parts.push(LANGUAGE_LABELS[generatedWithLanguage] ?? generatedWithLanguage);
  } else if (detectedLanguage) {
    parts.push(`${LANGUAGE_LABELS[detectedLanguage] ?? detectedLanguage} (auto-detected)`);
  } else {
    parts.push("Auto-detect");
  }
  return parts.join(" · ");
}

function formatFullTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}


/** Commit any active caption edit. Called from forward-moving menu actions
 * (save, new, open) so the user's typed text is preserved. Native menu clicks
 * don't produce a DOM mousedown, so they bypass the textarea's click-outside
 * commit. */
export function commitActiveEdit() {
  const idx = editingIndex.value;
  if (idx === null) return;
  handleEdit(idx, editText.value);
}

/** Discard any active caption edit without committing. Called from backward-
 * moving menu actions (undo, redo) where auto-committing would insert a new
 * history entry that the menu label promised would be undone. Mirrors the
 * Escape-in-textarea behavior. */
export function cancelActiveEdit() {
  if (editingIndex.value === null) return;
  _editCancelled = true;
  editingIndex.value = null;
  if (getPendingAddIndex() !== null) {
    cancelPendingAdd();
  }
}

function handleEdit(index: number, text: string) {
  _editCancelled = true; // prevent re-entry if textarea blur fires after unmount
  editingIndex.value = null;
  const proj = project.value;
  const media = selectedMedia.value;
  if (!proj || !media) return;

  const isPendingAdd = getPendingAddIndex() === index;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  if (!lines.length) {
    // Empty commit: cancel a pending add (no history), otherwise delete.
    if (isPendingAdd) {
      cancelPendingAdd();
    } else {
      deleteCaption(index);
    }
    return;
  }

  // Identity commit: user opened the editor but didn't change the text. Skip
  // pushing a history entry so Undo operates on the prior real change instead
  // of this no-op. Pending adds never hit this path — an unchanged pending add
  // means empty text, which is handled above.
  const existing = media.captions.find((c) => c.index === index);
  if (
    !isPendingAdd &&
    existing &&
    existing.lines.length === lines.length &&
    existing.lines.every((l, i) => l === lines[i])
  ) {
    return;
  }

  const newProject = {
    ...proj,
    media: proj.media.map((m) =>
      m.id !== media.id ? m : {
        ...m,
        captions: m.captions.map((c) =>
          c.index !== index ? c : { ...c, lines, edited: true }
        ),
      }
    ),
  };

  if (isPendingAdd) {
    commitPendingAdd(newProject);
  } else {
    pushHistory(newProject, "Edit caption");
  }
}
