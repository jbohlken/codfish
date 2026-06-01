import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { SelectButton } from "../SelectButton";
import { ActionMenuButton, type ActionMenuItem } from "../ActionMenuButton";
import {
  project,
  isDirty,
  profiles,
  selectedProfile,
  selectedMedia,
  selectedExportFormat,
  exportFormats,
} from "../../store/app";
import type { TranscriptionModel } from "../../types/project";
import { CircleIcon as Circle, WaveformIcon as Waveform, TranslateIcon as Translate, SlidersIcon as Sliders, FishIcon as Fish, WrenchIcon as Wrench, FileTextIcon as FileText, ArrowsClockwiseIcon as ArrowsClockwise, ExportIcon as ExportIcon } from "@phosphor-icons/react";
import { openProfileManager } from "../ProfileManager";
import { openFormatManager } from "../FormatManager";
import { hasUpdate, toggleUpdatePopover, UpdatePopover } from "../UpdateNotice";
import { listModels } from "../../lib/transcription";
import { listFormats } from "../../lib/export";
import { eligibleMediaIds, allTranscribableMediaIds, captionedMediaCount } from "../../lib/batch";
import { generateSelectedMedia, generateMissingMedia, regenerateAllMedia, exportSelectedMedia, exportAllMedia } from "../../lib/actions";

const TRANSCRIPTION_MODELS: { id: TranscriptionModel; label: string; size: string }[] = [
  { id: "tiny",     label: "Tiny",     size: "39 MB" },
  { id: "base",     label: "Base",     size: "74 MB" },
  { id: "small",    label: "Small",    size: "244 MB" },
  { id: "medium",   label: "Medium",   size: "769 MB" },
  { id: "large-v3", label: "Large v3", size: "1.5 GB" },
];

const LANGUAGES = [
  { code: "",   label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "ja", label: "Japanese" },
  { code: "zh", label: "Chinese" },
];

const modelCached = signal<Record<string, boolean>>({});
let _modelCacheLoaded = false;
async function loadModelCache() {
  if (_modelCacheLoaded) return;
  _modelCacheLoaded = true;
  try {
    const models = await listModels();
    const map: Record<string, boolean> = {};
    for (const m of models) map[m.id] = m.cached;
    modelCached.value = map;
  } catch { /* leave as empty — all show as uncached */ }
}

function buildProfileOptions() {
  const all = profiles.value;
  const builtins = all.filter((p) => p.builtIn);
  const custom = all.filter((p) => !p.builtIn);

  const options: ({ value: string; label: string } | { separator: true })[] = [];
  for (const p of builtins) options.push({ value: p.name, label: p.name });
  if (builtins.length > 0 && custom.length > 0) {
    options.push({ separator: true });
  }
  for (const p of custom) options.push({ value: p.name, label: p.name });
  return options;
}

function buildFormatOptions() {
  const formats = exportFormats.value;
  const builtins = formats.filter((f) => f.source === "builtin");
  const custom = formats.filter((f) => f.source === "custom");

  const options: ({ value: string; label: string } | { separator: true })[] = [];
  for (const f of builtins) options.push({ value: f.id, label: f.name });
  if (builtins.length > 0 && custom.length > 0) {
    options.push({ separator: true });
  }
  for (const f of custom) options.push({ value: f.id, label: f.name });
  return options;
}

async function loadFormats() {
  exportFormats.value = await listFormats();
}

export function TitleBar() {
  const proj = project.value;
  const dirty = isDirty.value;
  const cached = modelCached.value;
  const cacheLoaded = Object.keys(cached).length > 0;

  const media = selectedMedia.value;
  // All three counts are computed-signal-backed: filter cost is paid once
  // per project change, not on every render.
  const missingCount = eligibleMediaIds.value.length;
  const captionedCount = captionedMediaCount.value;
  const transcribableCount = allTranscribableMediaIds.value.length;
  const selectedHasCaptions = (media?.captions.length ?? 0) > 0;
  const selectedHasAudio = media?.hasAudio ?? true;

  // No batch-state gating here: when a batch is running the whole app-shell
  // is inert (App.tsx) and the BatchBlocker takes over, so these controls
  // are unreachable. Single source of truth.
  const generateItems: ActionMenuItem[] = [
    {
      label: selectedHasCaptions ? "Regenerate current file" : "Generate current file",
      disabled: !media || !selectedHasAudio,
      disabledReason: !media
        ? "Select a media item first"
        : "Selected file has no audio track",
      onClick: generateSelectedMedia,
    },
    {
      label: "Generate missing",
      meta: `(${missingCount})`,
      description: "Files without captions yet",
      disabled: missingCount === 0,
      disabledReason: "All files already have captions",
      onClick: generateMissingMedia,
    },
    {
      label: "Regenerate everything",
      meta: `(${transcribableCount})`,
      description: "Replaces all captions and edits",
      danger: true,
      disabled: transcribableCount === 0 || captionedCount === 0,
      disabledReason: captionedCount === 0 ? "Nothing generated yet" : "No transcribable media",
      onClick: regenerateAllMedia,
    },
  ];

  const exportItems: ActionMenuItem[] = [
    {
      label: "Export current file",
      disabled: !selectedHasCaptions,
      disabledReason: !media ? "Select a media item first" : "Selected file has no captions",
      onClick: exportSelectedMedia,
    },
    {
      label: "Export all",
      meta: `(${captionedCount})`,
      disabled: captionedCount === 0,
      disabledReason: "No captioned media to export",
      onClick: exportAllMedia,
    },
  ];

  useEffect(() => { loadModelCache(); loadFormats(); }, []);

  return (
    <div class="titlebar">
      <div class="titlebar-left">
        <span class="titlebar-app-name">Codfish</span>
        {proj && (
          <>
            <span class="titlebar-divider">/</span>
            <span class="titlebar-project-name">
              {proj.name}
              {dirty && <span class="titlebar-dirty" data-tooltip="Unsaved changes"><Circle size={8} weight="fill" /></span>}
            </span>
          </>
        )}
      </div>

      <div class="titlebar-center" />

      <div class="titlebar-right">
        {hasUpdate() && (
          <div class="update-icon-wrapper">
            <button
              class="btn btn-ghost update-icon"
              onClick={toggleUpdatePopover}
            >
              <Fish size={14} weight="fill" /> Update available
            </button>
            <UpdatePopover />
          </div>
        )}

        {proj && (
          <>
            <SelectButton
              icon={Waveform}
              tooltip="Transcription model"
              options={TRANSCRIPTION_MODELS.map((m) => ({
                value: m.id,
                label: m.label,
                meta: m.size,
                badge: cacheLoaded ? !(cached[m.id] ?? true) : undefined,
              }))}
              value={proj.transcriptionModel}
              onChange={(v) => { project.value = { ...proj, transcriptionModel: v }; isDirty.value = true; }}
            />
            <SelectButton
              icon={Translate}
              tooltip="Language"
              options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
              value={proj.language}
              onChange={(v) => { project.value = { ...proj, language: v }; isDirty.value = true; }}
            />
            <SelectButton
              icon={Sliders}
              tooltip="Caption profile"
              options={buildProfileOptions()}
              value={selectedProfile.value}
              onChange={(v) => {
                selectedProfile.value = v;
                isDirty.value = true;
              }}
              footer={(close) => (
                <button class="titlebar-select-option" onClick={() => { close(); openProfileManager(); }}>
                  <span class="titlebar-select-option-name" style="display:flex;align-items:center;gap:6px"><Wrench size={12} /> Manage caption profiles…</span>
                </button>
              )}
            />
            <ActionMenuButton
              icon={ArrowsClockwise}
              label="Generate"
              tooltip="Generate captions"
              items={generateItems}
            />

            <div class="titlebar-divider" />

            <SelectButton
              icon={FileText}
              tooltip="Export format"
              options={buildFormatOptions()}
              value={selectedExportFormat.value}
              onChange={(v) => { selectedExportFormat.value = v; isDirty.value = true; }}
              footer={(close) => (
                <button class="titlebar-select-option" onClick={() => { close(); openFormatManager(); }}>
                  <span class="titlebar-select-option-name" style="display:flex;align-items:center;gap:6px"><Wrench size={12} /> Manage export formats…</span>
                </button>
              )}
            />
            <ActionMenuButton
              icon={ExportIcon}
              label="Export"
              tooltip="Export captions"
              items={exportItems}
            />
          </>
        )}
      </div>
    </div>
  );
}
