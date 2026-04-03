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
import { transcribeMedia, listModels, type ModelInfo, type TranscriptionProgress } from "../../lib/transcription";
import { listFormats, exportCaptions, openFormatsDir, type ExportFormat } from "../../lib/export";
import { showError } from "../ErrorModal";
import type { CaptionBlock } from "../../types/project";

// ── Panel-local state ─────────────────────────────────────────────────────────
const models = signal<ModelInfo[]>([]);
const selectedModelId = signal("base");
const language = signal("");
const isGenerating = signal(false);
const generateProgress = signal<TranscriptionProgress | null>(null);
const editingIndex = signal<number | null>(null);
const editText = signal("");
const exportFormats = signal<ExportFormat[]>([]);
const selectedFormatId = signal("");
const generateSettingsOpen = signal(false);
const exportSettingsOpen = signal(false);

export { editingIndex, editText };

// Flag to suppress onBlur commit when Escape is pressed in the textarea
let _editCancelled = false;

// ── One-time loaders ──────────────────────────────────────────────────────────

let modelsLoaded = false;
async function loadModels(force = false) {
  if (modelsLoaded && !force) return;
  modelsLoaded = true;
  try {
    models.value = await listModels();
  } catch {
    models.value = [
      { id: "tiny",     name: "Tiny (39 MB)",     sizeMb: 39,   cached: false },
      { id: "base",     name: "Base (74 MB)",      sizeMb: 74,   cached: false },
      { id: "small",    name: "Small (244 MB)",    sizeMb: 244,  cached: false },
      { id: "medium",   name: "Medium (769 MB)",   sizeMb: 769,  cached: false },
      { id: "large-v3", name: "Large v3 (1.5 GB)", sizeMb: 1550, cached: false },
    ];
  }
}

async function loadFormats() {
  const formats = await listFormats();
  exportFormats.value = formats;
  if (formats.length && !formats.find((f) => f.id === selectedFormatId.value)) {
    selectedFormatId.value = formats[0].id;
  }
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
    loadModels();
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

  // Close popovers on outside click
  useEffect(() => {
    if (!generateSettingsOpen.value && !exportSettingsOpen.value) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".split-btn-wrap")) {
        generateSettingsOpen.value = false;
        exportSettingsOpen.value = false;
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [generateSettingsOpen.value, exportSettingsOpen.value]);

  const media = selectedMedia.value;
  const generating = isGenerating.value;
  const progress = generateProgress.value;
  const hasCaptions = (media?.captions.length ?? 0) > 0;
  const currentTime = playbackTime.value;
  const playingIndex = media?.captions.find(
    (c) => currentTime >= c.start && currentTime < c.end
  )?.index ?? null;

  return (
    <div class="panel caption-panel">
      <div class="panel-header">
        <span class="panel-header-title">Captions</span>
        {media && !generating && (
          <button
            class="btn btn-ghost btn-icon"
            title="Add caption at playhead (A)"
            onClick={addCaption}
          >
            +
          </button>
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
            <span class="empty-state-body">Generate captions to get started.</span>
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

      {media && !generating && (
        <div class="caption-panel-footer">
          {/* Generate button + gear */}
          <div class="split-btn-wrap">
            {generateSettingsOpen.value && (
              <div class="split-popover">
                <div class="caption-generate-row">
                  <label class="caption-control-label">Model</label>
                  <select
                    class="caption-control-select"
                    value={selectedModelId.value}
                    onChange={(e) => { selectedModelId.value = e.currentTarget.value; }}
                  >
                    {models.value.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}{m.cached ? "" : " ↓"}
                      </option>
                    ))}
                  </select>
                </div>
                <div class="caption-generate-row">
                  <label class="caption-control-label">Language</label>
                  <select
                    class="caption-control-select"
                    value={language.value}
                    onChange={(e) => { language.value = e.currentTarget.value; }}
                  >
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="ja">Japanese</option>
                    <option value="zh">Chinese</option>
                    <option value="">Auto-detect</option>
                  </select>
                </div>
              </div>
            )}
            <div class="caption-action-row">
              <button class="btn btn-primary" onClick={handleGenerate}>Generate</button>
              <button
                class={`btn btn-ghost btn-icon${generateSettingsOpen.value ? " btn-icon--active" : ""}`}
                title="Generation settings"
                onClick={() => {
                  generateSettingsOpen.value = !generateSettingsOpen.value;
                  exportSettingsOpen.value = false;
                }}
              >
                ⚙
              </button>
            </div>
          </div>

          {/* Export button + gear — only when captions exist */}
          {hasCaptions && (
            <div class="split-btn-wrap">
              {exportSettingsOpen.value && (
                <div class="split-popover">
                  <div class="caption-generate-row">
                    <label class="caption-control-label">Format</label>
                    <div class="caption-format-row">
                      <select
                        class="caption-control-select"
                        value={selectedFormatId.value}
                        onChange={(e) => { selectedFormatId.value = e.currentTarget.value; }}
                      >
                        {exportFormats.value.map((f) => (
                          <option key={f.id} value={f.id}>{f.name}</option>
                        ))}
                      </select>
                      <button
                        class="btn btn-ghost btn-icon caption-formats-dir-btn"
                        title="Open custom formats folder"
                        onClick={openFormatsDir}
                      >
                        ↗
                      </button>
                    </div>
                  </div>
                </div>
              )}
              <div class="caption-action-row">
                <button class="btn btn-secondary" onClick={() => handleExport(media.name)}>Export…</button>
                <button
                  class={`btn btn-ghost btn-icon${exportSettingsOpen.value ? " btn-icon--active" : ""}`}
                  title="Export settings"
                  onClick={() => {
                    exportSettingsOpen.value = !exportSettingsOpen.value;
                    generateSettingsOpen.value = false;
                  }}
                >
                  ⚙
                </button>
              </div>
            </div>
          )}
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
      class={`caption-row${selected ? " caption-row--selected" : playing ? " caption-row--playing" : ""}`}
      data-caption-index={block.index}
      onClick={onClick}
      onDblClick={onDblClick}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onClick(); }}
    >
      <div class="caption-row-meta">#{block.index} · {formatTime(block.start)} → {formatTime(block.end)}</div>
      <div class="caption-row-text">{block.lines.join("\n")}</div>
      {selected && (
        <div class="caption-row-actions" onClick={(e) => e.stopPropagation()}>
          <button
            class="btn-caption-action"
            title="Edit (E)"
            onClick={() => {
              isPlaying.value = false;
              editingIndex.value = block.index;
              editText.value = block.lines.join("\n");
            }}
          >
            ✎
          </button>
          <button
            class="btn-caption-action"
            disabled={!splitEnabled}
            title={splitEnabled ? "Split at playhead (S)" : "Position playhead inside this caption to split"}
            onClick={onSplit}
          >
            ✂
          </button>
          <button
            class="btn-caption-action btn-caption-action--delete"
            title="Delete (Delete)"
            onClick={onDelete}
          >
            ✕
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
      selectedModelId.value,
      language.value || null,
      (p) => { generateProgress.value = p; },
    );
    loadModels(true);
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
  if (!media || media.captions.length === 0) return;

  const format = exportFormats.value.find((f) => f.id === selectedFormatId.value);
  if (!format) return;

  try {
    await exportCaptions(format, media.captions, baseName);
  } catch (e) {
    showError(String(e));
  }
}
