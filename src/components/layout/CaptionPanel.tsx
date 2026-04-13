import { useEffect, useRef } from "preact/hooks";
import { signal, useSignalEffect } from "@preact/signals";
import {
  selectedMedia,
  selectedCaptionIndex,
  playbackTime,
  project,
  activeProfile,
  pushHistory,
  mediaDuration,
  isPlaying,
  exportFormats,
  selectedExportFormat,
  isDirty,
} from "../../store/app";
import { snapToFrame, runPipeline, formatPhraseToCaptionLines } from "../../lib/pipeline";
import { framesBetween } from "../../lib/time";
import { formatDisplayTime } from "../../lib/time";
import { makePhrase } from "../../lib/pipeline/types";
import { PlusIcon as Plus, ArrowsClockwiseIcon as ArrowsClockwise, PencilSimpleIcon as PencilSimple, ScissorsIcon as Scissors, ArrowsMergeIcon as ArrowsMerge, XIcon as X, ExportIcon as ExportIcon, FileTextIcon as FileText, InfoIcon as Info, WarningIcon as Warning, WrenchIcon as Wrench } from "@phosphor-icons/react";
import { SelectButton } from "../SelectButton";
import { openFormatManager } from "../FormatManager";
import { validate } from "../../lib/pipeline/validate";
import type { ValidationWarning } from "../../lib/pipeline/types";
import { WarningBadge } from "../WarningBadge";
import { transcribeMedia, type TranscriptionProgress, type TranscriptionResult } from "../../lib/transcription";
import { listFormats, exportCaptions } from "../../lib/export";
import { showError } from "../ErrorModal";
import type { CaptionBlock, TranscriptionModel } from "../../types/project";

// ── Panel-local state ─────────────────────────────────────────────────────────
const isGenerating = signal(false);
const generateProgress = signal<TranscriptionProgress | null>(null);
const confirmingRegenerate = signal(false);
const editingIndex = signal<number | null>(null);
const editText = signal("");
export { editingIndex, editText };

// Flag to suppress onBlur commit when Escape is pressed in the textarea
let _editCancelled = false;

// ── One-time loaders ──────────────────────────────────────────────────────────


async function loadFormats() {
  const fmts = await listFormats();
  exportFormats.value = fmts;
}

function buildFormatOptions() {
  const formats = exportFormats.value;
  const builtins = formats.filter((f) => f.source === "builtin");
  const custom = formats.filter((f) => f.source === "custom");

  const options: ({ value: string; label: string } | { separator: true; label?: string })[] = [];

  for (const f of builtins) options.push({ value: f.id, label: f.name });
  if (builtins.length > 0 && custom.length > 0) {
    options.push({ separator: true });
  }
  for (const f of custom) options.push({ value: f.id, label: f.name });

  return options;
}

// ── Caption operations ────────────────────────────────────────────────────────

function deleteCaption(index: number) {
  const proj = project.value;
  const media = selectedMedia.value;
  if (!proj || !media) return;

  const pos = media.captions.findIndex((c) => c.index === index);
  const newCaptions = media.captions
    .filter((c) => c.index !== index)
    .map((c, i) => ({ ...c, index: i + 1 }));

  const next = newCaptions[pos] ?? newCaptions[pos - 1] ?? null;
  selectedCaptionIndex.value = next?.index ?? null;

  pushHistory({
    ...proj,
    media: proj.media.map((m) =>
      m.id !== media.id ? m : { ...m, captions: newCaptions }
    ),
  }, "Delete caption");
}

function splitCaption(index: number) {
  const proj = project.value;
  const media = selectedMedia.value;
  if (!proj || !media) return;

  const block = media.captions.find((c) => c.index === index);
  if (!block) return;

  const t = playbackTime.value;
  if (t <= block.start || t >= block.end) return;

  const fps = media.fps ?? activeProfile.value.timing.defaultFps;

  // Caption must be at least 2 frames long to produce two non-empty halves.
  const totalFrames = framesBetween(block.start, block.end, fps);
  if (totalFrames < 2) return;

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

  // Words source: rawWords filtered to this block's time range.
  // Not available for manually added captions, and skipped for edited captions
  // so we don't overwrite the user's text with rawWords-derived text.
  const sourceWords = block.edited
    ? []
    : media.rawWords?.filter((w) => w.start < block.end && w.end > block.start) ?? [];

  let linesA: string[];
  let linesB: string[];

  if (sourceWords.length > 0) {
    const wordsA = sourceWords.filter((w) => w.start < splitPoint && (w.end <= splitPoint || (w.start + w.end) / 2 < splitPoint));
    const wordsB = sourceWords.filter((w) => !wordsA.includes(w));

    linesA = wordsA.length > 0
      ? formatPhraseToCaptionLines(makePhrase(wordsA), maxCharsPerLine, maxLines)
      : [""];
    linesB = wordsB.length > 0
      ? formatPhraseToCaptionLines(makePhrase(wordsB), maxCharsPerLine, maxLines)
      : [""];
  } else {
    // No word timing — split text proportionally at a word boundary
    const ratio = (splitPoint - block.start) / (block.end - block.start);
    const textWords = block.lines.join(" ").split(" ").filter(Boolean);
    const splitIdx = Math.max(1, Math.min(textWords.length - 1, Math.round(textWords.length * ratio)));
    linesA = [textWords.slice(0, splitIdx).join(" ")];
    linesB = [textWords.slice(splitIdx).join(" ")];
  }

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

  selectedCaptionIndex.value = blockA.index;
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

  // If either side was manually edited or added, fall back to text concat
  // so we don't overwrite the user's text with rawWords-derived text.
  const eitherEdited = blockA.edited || blockB.edited;
  let mergedLines: string[];
  const sourceWords = eitherEdited
    ? undefined
    : media.rawWords?.filter(
        (w) => w.start < blockB.end && w.end > blockA.start
      );

  if (sourceWords && sourceWords.length > 0) {
    mergedLines = formatPhraseToCaptionLines(
      makePhrase(sourceWords),
      maxCharsPerLine,
      maxLines,
    );
  } else {
    const combined = [...blockA.lines, ...blockB.lines].join(" ").trim();
    mergedLines = combined.length > 0 ? [combined] : [""];
  }

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

  const t = playbackTime.value;

  // Can't add inside an existing caption
  if (media.captions.some((c) => t >= c.start && t < c.end)) return;

  const fps = media.fps ?? activeProfile.value.timing.defaultFps;
  const start = snapToFrame(t, fps);
  const nextCaption = media.captions.find((c) => c.start > t);
  const maxEnd = nextCaption?.start ?? (mediaDuration.value || start + 5);
  const end = snapToFrame(Math.min(start + 2, maxEnd), fps);

  if (end <= start) return;

  const insertPos = media.captions.filter((c) => c.end <= t).length;

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

  pushHistory({
    ...proj,
    media: proj.media.map((m) =>
      m.id !== media.id ? m : { ...m, captions: newCaptions }
    ),
  }, "Add caption");

  const newIndex = insertPos + 1;
  _editCancelled = false;
  selectedCaptionIndex.value = newIndex;
  editingIndex.value = newIndex;
  editText.value = "";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CaptionPanel() {
  useEffect(() => {
    loadFormats();
  }, []);

  // Caption keyboard shortcuts (Edit, Delete, Split, Add)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement ||
        e.target instanceof HTMLTextAreaElement
      ) return;
      if (isGenerating.value) return;
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


  const media = selectedMedia.value;
  const generating = isGenerating.value;
  const progress = generateProgress.value;
  const hasCaptions = (media?.captions.length ?? 0) > 0;
  const currentTime = playbackTime.value;
  const playingCaption = media?.captions.find(
    (c) => currentTime >= c.start && currentTime < c.end
  ) ?? null;
  const playingIndex = playingCaption?.index ?? null;
  const canAddCaption = !playingCaption;

  const profile = activeProfile.value;
  const fps = media?.fps ?? profile.timing.defaultFps;
  const warningsByIndex = new Map<number, ValidationWarning[]>();
  if (media?.captions.length) {
    const report = validate(media.captions, profile, fps);
    for (const w of report.warnings) {
      const list = warningsByIndex.get(w.blockIndex) ?? [];
      list.push(w);
      warningsByIndex.set(w.blockIndex, list);
    }
  }

  const confirming = confirmingRegenerate.value;

  useEffect(() => {
    if (!confirming) return;
    const dismiss = () => { confirmingRegenerate.value = false; };
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, [confirming]);

  return (
    <div class="panel caption-panel">
      <div class="panel-header">
        <span class="panel-header-title">Captions</span>
        {media && !generating && (
          <div style="position:relative;display:flex;align-items:center;gap:2px">
            {media.alignmentDegraded && hasCaptions && (
              <button
                class="btn btn-ghost btn-icon"
                data-tooltip={"Word-level alignment failed for this media.\nCaptions are using sentence-level timing — try regenerating."}
                style="color:var(--warning, #d97706)"
              >
                <Warning size={14} />
              </button>
            )}
            {media.generatedAt && hasCaptions && (
              <button
                class="btn btn-ghost btn-icon"
                data-tooltip={`${formatGenerationMeta(media.generatedWithModel, media.generatedWithLanguage, media.detectedLanguage)}\n${formatFullTimestamp(media.generatedAt)}`}
              >
                <Info size={14} />
              </button>
            )}
            {hasCaptions && (
              <button
                class="btn btn-ghost btn-icon"
                data-tooltip="Regenerate captions"
                onClick={(e) => { e.stopPropagation(); confirmingRegenerate.value = true; }}
              >
                <ArrowsClockwise size={14} />
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
            {confirming && (
              <div class="regen-popover" onClick={(e) => e.stopPropagation()}>
                <span class="regen-popover-label">Regenerate captions?</span>
                <div class="regen-popover-actions">
                  <button class="btn btn-secondary btn-sm" onClick={() => { confirmingRegenerate.value = false; }}>Cancel</button>
                  <button class="btn btn-primary btn-sm" onClick={() => { confirmingRegenerate.value = false; handleGenerate(); }}>Regenerate</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div class="panel-body scrollable">
        {!media ? (
          <div class="empty-state">
            <span class="empty-state-body">Select a media item to view captions.</span>
          </div>
        ) : generating ? (
          <div class="empty-state">
            <span class="empty-state-title">Generating…</span>
            {progress && (
              <>
                <div class="progress-bar-track">
                  <div class="progress-bar-fill" style={{ width: `${progress.percent}%` }} />
                </div>
                <span class="empty-state-body">{progress.message}</span>
              </>
            )}
          </div>
        ) : media.captions.length === 0 ? (
          <div class="empty-state">
            <span class="empty-state-title">No captions yet</span>
            <button class="btn btn-primary btn-sm" onClick={handleGenerate}><ArrowsClockwise size={13} /> Generate</button>
          </div>
        ) : (
          <div class="caption-list" onClick={(e) => { if (e.target === e.currentTarget) selectedCaptionIndex.value = null; }}>
            {media.captions.map((block) => (
              <CaptionRow
                key={block.index}
                block={block}
                fps={fps}
                selected={selectedCaptionIndex.value === block.index}
                playing={playingIndex === block.index}
                editing={editingIndex.value === block.index}
                warnings={warningsByIndex.get(block.index) ?? []}
                splitEnabled={currentTime > block.start && currentTime < block.end && framesBetween(block.start, block.end, fps) >= 2}
                splitTooltip={
                  framesBetween(block.start, block.end, fps) < 2
                    ? "Caption too short to split"
                    : currentTime > block.start && currentTime < block.end
                      ? "Split at playhead (S)"
                      : "Position playhead inside this caption to split"
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

      {media && !generating && hasCaptions && (
        <div class="caption-panel-footer">
          <SelectButton
            icon={FileText}
            tooltip="Export format"
            direction="up"
            options={buildFormatOptions()}
            value={selectedExportFormat.value}
            onChange={(v) => { selectedExportFormat.value = v; isDirty.value = true; }}
            footer={(close) => (
              <button class="titlebar-select-option" onClick={() => { close(); openFormatManager(); }}>
                <span class="titlebar-select-option-name" style="display:flex;align-items:center;gap:6px"><Wrench size={12} /> Manage export formats…</span>
              </button>
            )}
          />
          <div style="flex:1" />
          <button class="btn btn-primary btn-sm" onClick={() => handleExport(media.name)}>
            <ExportIcon size={13} /> Export
          </button>
        </div>
      )}
    </div>
  );
}

// ── Caption row ───────────────────────────────────────────────────────────────

function CaptionRow({
  block,
  fps,
  selected,
  playing,
  editing,
  warnings,
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

  if (editing) {
    return (
      <div class="caption-row caption-row--selected" data-caption-index={block.index}>
        <div class="caption-row-meta">#{block.index} · {formatDisplayTime(block.start, "time", fps, true)} → {formatDisplayTime(block.end, "time", fps, true)}</div>
        <textarea
          ref={textareaRef}
          class="caption-row-editor"
          value={editText.value}
          onInput={(e) => { editText.value = e.currentTarget.value; }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              _editCancelled = true;
              editingIndex.value = null;
              if (!block.lines.join("").trim()) {
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


  return (
    <div
      class={`caption-row${selected ? " caption-row--selected" : ""}${playing ? " caption-row--playing" : ""}`}
      data-caption-index={block.index}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onDblClick={onDblClick}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onClick(); }}
    >
      <div class="caption-row-meta">
        #{block.index} · {formatDisplayTime(block.start, "time", fps, true)} → {formatDisplayTime(block.end, "time", fps, true)}
        {warnings.length > 0 && (
          <WarningBadge warnings={warnings} />
        )}
      </div>
      <div class="caption-row-text">{block.lines.join("\n")}</div>
      {selected && (
        <div class="caption-row-actions" onClick={(e) => e.stopPropagation()}>
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


function handleEdit(index: number, text: string) {
  _editCancelled = true; // prevent re-entry if textarea blur fires after unmount
  editingIndex.value = null;
  const proj = project.value;
  const media = selectedMedia.value;
  if (!proj || !media) return;

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) {
    deleteCaption(index);
    return;
  }

  pushHistory({
    ...proj,
    media: proj.media.map((m) =>
      m.id !== media.id ? m : {
        ...m,
        captions: m.captions.map((c) =>
          c.index !== index ? c : { ...c, lines, edited: true }
        ),
      }
    ),
  }, "Edit caption");
}

async function handleGenerate() {
  const media = selectedMedia.value;
  const proj = project.value;
  if (!media || !proj) return;

  confirmingRegenerate.value = false;
  isGenerating.value = true;
  generateProgress.value = { stage: "transcribing", percent: 0, message: "Starting up…" };

  try {
    const { words, detectedLanguage, alignmentDegraded }: TranscriptionResult = await transcribeMedia(
      media.path,
      proj.transcriptionModel,
      proj.language || null,
      (p) => { generateProgress.value = p; },
    );
    const { captions } = runPipeline(words, activeProfile.value, media.fps ?? undefined);
    const current = project.value;
    if (!current) return;
    const autoDetect = !proj.language;
    pushHistory({
      ...current,
      media: current.media.map((m) =>
        m.id === media.id
          ? {
              ...m,
              captions,
              rawWords: words,
              generatedAt: new Date().toISOString(),
              generatedWithModel: proj.transcriptionModel,
              generatedWithLanguage: autoDetect ? undefined : proj.language,
              detectedLanguage: autoDetect ? detectedLanguage : undefined,
              alignmentDegraded,
            }
          : m,
      ),
    }, "Generate captions");
  } catch (e) {
    showError(String(e));
  } finally {
    isGenerating.value = false;
    generateProgress.value = null;
  }
}

async function handleExport(baseName: string) {
  const media = selectedMedia.value;
  if (!media || media.captions.length === 0) return;

  const format = exportFormats.value.find((f) => f.id === selectedExportFormat.value);
  if (!format) return;

  const fps = media.fps ?? activeProfile.value.timing.defaultFps;

  try {
    await exportCaptions(format, media.captions, baseName, fps, media.dropFrame ?? false);
  } catch (e) {
    showError(String(e));
  }
}
