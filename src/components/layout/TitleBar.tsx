import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { SelectButton } from "../SelectButton";
import { project, isDirty, activeProfile, profiles, pushHistory, canUndo, canRedo, undo, redo, undoDescription, redoDescription } from "../../store/app";
import type { TranscriptionModel } from "../../types/project";
import { SunIcon as Sun, MoonIcon as Moon, QuestionIcon as Question, ArrowCounterClockwiseIcon as ArrowCounterClockwise, ArrowClockwiseIcon as ArrowClockwise, PencilSimpleIcon as PencilSimple, CircleIcon as Circle, WaveformIcon as Waveform, TranslateIcon as Translate, SlidersIcon as Sliders, FishIcon as Fish, BugIcon as Bug, UploadSimpleIcon as UploadSimple } from "@phosphor-icons/react";
import { profileEditorOpen } from "../ProfileEditor";
import { importProfile } from "../../lib/profiles";
import { helpOpen } from "../HelpModal";
import { bugReportOpen } from "../BugReportModal";
import { hasUpdate, toggleUpdatePopover, UpdatePopover } from "../UpdateNotice";
import { theme, toggleTheme } from "../../store/theme";
import { listModels } from "../../lib/transcription";

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

export function TitleBar() {
  const proj = project.value;
  const dirty = isDirty.value;
  const profile = activeProfile.value;
  const cached = modelCached.value;
  const cacheLoaded = Object.keys(cached).length > 0;

  useEffect(() => { loadModelCache(); }, []);

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
        <button
          class="btn btn-ghost btn-icon"
          data-tooltip={theme.value === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={toggleTheme}
        >
          {theme.value === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <button
          class="btn btn-ghost btn-icon"
          data-tooltip="Submit feedback"
          onClick={() => { bugReportOpen.value = true; }}
        >
          <Bug size={14} />
        </button>
        <button
          class="btn btn-ghost btn-icon"
          data-tooltip="Help"
          onClick={() => { helpOpen.value = true; }}
        >
          <Question size={14} />
        </button>

        {proj && (
          <>
            <div class="titlebar-divider" />

            <button
              class="btn btn-ghost btn-icon"
              onClick={undo}
              disabled={!canUndo.value}
              data-tooltip={undoDescription.value ? `Undo: ${undoDescription.value} (Ctrl+Z)` : "Nothing to undo"}
            >
              <ArrowCounterClockwise size={14} />
            </button>
            <button
              class="btn btn-ghost btn-icon"
              onClick={redo}
              disabled={!canRedo.value}
              data-tooltip={redoDescription.value ? `Redo: ${redoDescription.value} (Ctrl+Y)` : "Nothing to redo"}
            >
              <ArrowClockwise size={14} />
            </button>

            <div class="titlebar-divider" />

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
              onChange={(v) => pushHistory({ ...proj, transcriptionModel: v }, "Change model")}
            />
            <SelectButton
              icon={Translate}
              tooltip="Language"
              options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
              value={proj.language}
              onChange={(v) => pushHistory({ ...proj, language: v }, "Change language")}
            />

            <div class="titlebar-divider" />

            <SelectButton
              icon={Sliders}
              tooltip="Caption profile"
              options={profiles.value.map((p) => ({ value: p.id, label: p.name }))}
              value={profile.id}
              onChange={(v) => pushHistory({ ...proj, profileId: v }, "Change profile")}
              footer={(close) => (
                <button
                  class="titlebar-select-option"
                  onClick={async () => {
                    close();
                    const imported = await importProfile();
                    if (imported) {
                      profiles.value = [...profiles.value, imported];
                      pushHistory({ ...proj, profileId: imported.id }, "Import profile");
                    }
                  }}
                >
                  <span class="titlebar-select-option-name" style="display:flex;align-items:center;gap:6px"><UploadSimple size={12} /> Import profile...</span>
                </button>
              )}
            />
            <button
              class="btn btn-ghost btn-icon"
              data-tooltip="Edit profile"
              onClick={() => { profileEditorOpen.value = true; }}
            >
              <PencilSimple size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
