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
} from "../../store/app";
import { snapToFrame, runPipeline } from "../../lib/pipeline";
import { PlusIcon as Plus, ArrowsClockwiseIcon as ArrowsClockwise, PencilSimpleIcon as PencilSimple, ScissorsIcon as Scissors, XIcon as X, ArrowSquareOutIcon as ArrowSquareOut, ExportIcon as ExportIcon, FileTextIcon as FileText } from "@phosphor-icons/react";
import { SelectButton } from "../SelectButton";
import { validate } from "../../lib/pipeline/validate";
import type { ValidationWarning } from "../../lib/pipeline/types";
import { WarningBadge } from "../WarningBadge";
import { transcribeMedia, type TranscriptionProgress } from "../../lib/transcription";
import { listFormats, exportCaptions, openFormatsDir, type ExportFormat } from "../../lib/export";
import { showError } from "../ErrorModal";
import type { CaptionBlock } from "../../types/project";

// ── Panel-local state ─────────────────────────────────────────────────────────
const isGenerating = signal(false);
const generateProgress = signal<TranscriptionProgress | null>(null);
const editingIndex = signal<number | null>(null);
const editText = signal("");
const exportFormats = signal<ExportFormat[]>([]);

export { editingIndex, editText };

// Flag to suppress onBlur commit when Escape is pressed in the textarea
let _editCancelled = false;

// ── One-time loaders ──────────────────────────────────────────────────────────


async function loadFormats() {
  exportFormats.value = await listFormats();
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
  const splitPoint = snapToFrame(t, fps);

  // Assign words to each half if available in memory
  const wordsA = block.words?.filter((w) => w.end <= splitPoint) ?? [];
  const wordsB = block.words?.filter((w) => w.start >= splitPoint) ?? [];

  const linesA = wordsA.length > 0
    ? [wordsA.map((w) => w.text).join(" ").trim()]
    : block.lines;
  const linesB = wordsB.length > 0
    ? [wordsB.map((w) => w.text).join(" ").trim()]
    : [""];

  const blockA: CaptionBlock = {
    ...block,
    end: splitPoint,
    lines: linesA,
    words: wordsA.length ? wordsA : undefined,
  };
  const blockB: CaptionBlock = {
    ...block,
    start: splitPoint,
    lines: linesB,
    words: wordsB.length ? wordsB : undefined,
  };

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
  const playingIndex = media?.captions.find(
    (c) => currentTime >= c.start && currentTime < c.end
  )?.index ?? null;

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

  return (
    <div class="panel caption-panel">
      <div class="panel-header">
        <span class="panel-header-title">Captions</span>
        {media && !generating && (
          <div style="display:flex;align-items:center;gap:2px">
            {hasCaptions && (
              <button
                class="btn btn-ghost btn-icon"
                data-tooltip="Regenerate captions"
                onClick={handleGenerate}
              >
                <ArrowsClockwise size={14} />
              </button>
            )}
            <button
              class="btn btn-ghost btn-icon"
              data-tooltip="Add caption at playhead (A)"
              onClick={addCaption}
            >
              <Plus size={14} />
            </button>
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
                selected={selectedCaptionIndex.value === block.index}
                playing={playingIndex === block.index}
                editing={editingIndex.value === block.index}
                warnings={warningsByIndex.get(block.index) ?? []}
                splitEnabled={currentTime > block.start && currentTime < block.end}
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
            options={exportFormats.value.map((f) => ({ value: f.id, label: f.name }))}
            value={project.value?.exportFormatId ?? exportFormats.value[0]?.id ?? ""}
            onChange={(v) => { if (project.value) pushHistory({ ...project.value, exportFormatId: v }, "Change export format"); }}
          />
          <button
            class="btn btn-ghost btn-icon"
            data-tooltip="Open custom formats folder"
            onClick={openFormatsDir}
          >
            <ArrowSquareOut size={14} />
          </button>
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
  selected,
  playing,
  editing,
  warnings,
  splitEnabled,
  onClick,
  onDblClick,
  onEdit,
  onSplit,
  onDelete,
}: {
  block: CaptionBlock;
  selected: boolean;
  playing: boolean;
  editing: boolean;
  warnings: ValidationWarning[];
  splitEnabled: boolean;
  onClick: () => void;
  onDblClick: () => void;
  onEdit: (text: string) => void;
  onSplit: () => void;
  onDelete: () => void;
}) {
  if (editing) {
    return (
      <div class="caption-row caption-row--selected" data-caption-index={block.index}>
        <div class="caption-row-meta">#{block.index} · {formatTime(block.start)} → {formatTime(block.end)}</div>
        <textarea
          class="caption-row-editor"
          value={editText.value}
          onInput={(e) => { editText.value = e.currentTarget.value; }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              _editCancelled = true;
              editingIndex.value = null;
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
      onClick={onClick}
      onDblClick={onDblClick}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onClick(); }}
    >
      <div class="caption-row-meta">
        #{block.index} · {formatTime(block.start)} → {formatTime(block.end)}
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
            data-tooltip={splitEnabled ? "Split at playhead (S)" : "Position playhead inside this caption to split"}
            onClick={onSplit}
          >
            <Scissors size={14} />
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

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 1000);
  return `${m}:${String(sec).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function handleEdit(index: number, text: string) {
  editingIndex.value = null;
  const proj = project.value;
  const media = selectedMedia.value;
  if (!proj || !media) return;

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;

  pushHistory({
    ...proj,
    media: proj.media.map((m) =>
      m.id !== media.id ? m : {
        ...m,
        captions: m.captions.map((c) =>
          c.index !== index ? c : { ...c, lines }
        ),
      }
    ),
  }, "Edit caption");
}

async function handleGenerate() {
  const media = selectedMedia.value;
  const proj = project.value;
  if (!media || !proj) return;

  isGenerating.value = true;
  generateProgress.value = null;

  try {
    const words = await transcribeMedia(
      media.path,
      proj.transcriptionModel,
      proj.language || null,
      (p) => { generateProgress.value = p; },
    );
    const { captions } = runPipeline(words, activeProfile.value, media.fps ?? undefined);
    pushHistory({
      ...proj,
      media: proj.media.map((m) =>
        m.id === media.id
          ? { ...m, captions, generatedAt: new Date().toISOString() }
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
  const proj = project.value;
  if (!media || media.captions.length === 0 || !proj) return;

  const formatId = proj.exportFormatId ?? exportFormats.value[0]?.id;
  const format = exportFormats.value.find((f) => f.id === formatId);
  if (!format) return;

  try {
    await exportCaptions(format, media.captions, baseName);
  } catch (e) {
    showError(String(e));
  }
}
