import { signal } from "@preact/signals";
import { useState, useEffect, useRef } from "preact/hooks";
import {
  XIcon as X,
  PlusIcon as Plus,
  TrashIcon as Trash,
  CopyIcon as Copy,
  ExportIcon as ExportIcon,
  DownloadSimpleIcon as Import,
  LockIcon as Lock,
  CaretRightIcon as CaretRight,
  CaretDownIcon as CaretDown,
} from "@phosphor-icons/react";
import { profiles, selectedProfile } from "../store/app";
import type { CaptionProfile, ProfileRule, TimedRule } from "../types/profile";
import {
  loadProfiles,
  saveProfile as saveProfileToDisk,
  deleteProfile as deleteProfileFromDisk,
  exportProfile,
  importProfile,
} from "../lib/profiles";
import { showError } from "./ErrorModal";
import { confirmUnsavedChanges } from "./UnsavedChanges";

// ── State ───────────────────────────────────────────────────────────────────

export const profileManagerOpen = signal(false);

let _guardLeave: (() => Promise<boolean>) | null = null;

export function openProfileManager() {
  profileManagerOpen.value = true;
}

/** Ask the profile manager to close, respecting unsaved-changes guard.
 *  Returns true if it closed, false if the user cancelled. */
export async function requestCloseProfileManager(): Promise<boolean> {
  if (!profileManagerOpen.value) return true;
  if (_guardLeave && !(await _guardLeave())) return false;
  profileManagerOpen.value = false;
  return true;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function cloneProfile(p: CaptionProfile): CaptionProfile {
  return JSON.parse(JSON.stringify(p));
}

function uniqueProfileName(base: string, existing: CaptionProfile[]): string {
  const names = new Set(existing.map((p) => p.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!names.has(candidate)) return candidate;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function rangeTooltip(min: number, max: number, unit?: string): string {
  const u = unit ? ` ${unit}` : "";
  return `${min}–${max}${u}`;
}

// ── Editor state ────────────────────────────────────────────────────────────

interface EditorState {
  profile: CaptionProfile;
  savedProfile: CaptionProfile;
  readonly: boolean;
}

// ── Component ───────────────────────────────────────────────────────────────

export function ProfileManager() {
  const isOpen = profileManagerOpen.value;
  const allProfiles = profiles.value;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const nameRef = useRef<HTMLInputElement | null>(null);
  const focusNameOnNext = useRef(false);

  // Reset state when modal opens
  useEffect(() => {
    if (!isOpen) return;
    setEditor(null);
    setSelectedId(null);
    setConfirmingDelete(false);
    setAdvancedOpen(false);
  }, [isOpen]);

  // Dismiss delete confirm on click-outside
  useEffect(() => {
    if (!confirmingDelete) return;
    const dismiss = () => setConfirmingDelete(false);
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, [confirmingDelete]);

  // Focus + select the name field when a new profile is created
  useEffect(() => {
    if (editor && focusNameOnNext.current) {
      focusNameOnNext.current = false;
      requestAnimationFrame(() => {
        nameRef.current?.focus();
        nameRef.current?.select();
      });
    }
  }, [editor]);

  const isDirty = (): boolean => {
    if (!editor || editor.readonly) return false;
    return JSON.stringify(editor.profile) !== JSON.stringify(editor.savedProfile);
  };

  const guardLeave = async (): Promise<boolean> => {
    if (!isDirty()) return true;
    const choice = await confirmUnsavedChanges(
      "You have unsaved changes to this profile. Save before leaving?",
      { title: "Unsaved profile changes" },
    );
    if (choice === "cancel") return false;
    if (choice === "discard") return true;
    return await performSave();
  };

  // Expose guard to the module-level requestClose function.
  useEffect(() => {
    _guardLeave = guardLeave;
    return () => { _guardLeave = null; };
  });

  const getNameError = (name: string, id: string): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return "Name can't be empty";
    if (allProfiles.some((p) => p.id !== id && p.name === trimmed)) {
      return `A profile named "${trimmed}" already exists`;
    }
    return null;
  };

  const performSave = async (): Promise<boolean> => {
    if (!editor) return true;
    const profile = editor.profile;
    const oldName = editor.savedProfile.name;

    if (getNameError(profile.name, profile.id)) return false;
    profile.name = profile.name.trim();

    try {
      await saveProfileToDisk(profile);
      const loaded = await loadProfiles();
      profiles.value = loaded;
      const saved = loaded.find((p) => p.id === profile.id);
      if (saved) {
        if (selectedProfile.value === oldName) {
          selectedProfile.value = saved.name;
        }
        setEditor({
          profile: cloneProfile(saved),
          savedProfile: cloneProfile(saved),
          readonly: saved.builtIn,
        });
        setSelectedId(saved.id);
      }
      return true;
    } catch (e) {
      showError(String(e));
      return false;
    }
  };

  const selectProfile = (p: CaptionProfile) => {
    setSelectedId(p.id);
    setConfirmingDelete(false);
    setAdvancedOpen(false);
    setEditor({
      profile: cloneProfile(p),
      savedProfile: cloneProfile(p),
      readonly: p.builtIn,
    });
  };

  const handleListClick = async (p: CaptionProfile) => {
    if (p.id === selectedId) return;
    if (!(await guardLeave())) return;
    selectProfile(p);
  };

  const close = async () => {
    if (!(await guardLeave())) return;
    profileManagerOpen.value = false;
    setSelectedId(null);
    setEditor(null);
  };

  const startNew = async () => {
    if (!(await guardLeave())) return;
    const defaultProfile = allProfiles.find((p) => p.id === "default") ?? allProfiles[0];
    if (!defaultProfile) return;
    const name = uniqueProfileName("New profile", allProfiles);
    const newProfile: CaptionProfile = {
      ...cloneProfile(defaultProfile),
      id: `user_${Date.now()}`,
      name,
      description: "",
      builtIn: false,
    };
    try {
      await saveProfileToDisk(newProfile);
      const loaded = await loadProfiles();
      profiles.value = loaded;
      const created = loaded.find((p) => p.name === name);
      if (created) {
        focusNameOnNext.current = true;
        selectProfile(created);
      }
    } catch (e) {
      showError(String(e));
    }
  };

  const handleDuplicate = async () => {
    if (!editor) return;
    if (!(await guardLeave())) return;
    const base = editor.savedProfile;
    const name = uniqueProfileName(`${base.name} (copy)`, allProfiles);
    const dup: CaptionProfile = {
      ...cloneProfile(base),
      id: `user_${Date.now()}`,
      name,
      builtIn: false,
    };
    try {
      await saveProfileToDisk(dup);
      const loaded = await loadProfiles();
      profiles.value = loaded;
      const created = loaded.find((p) => p.name === name);
      if (created) selectProfile(created);
    } catch (e) {
      showError(String(e));
    }
  };

  const handleDelete = async () => {
    if (!editor || editor.readonly) return;
    try {
      await deleteProfileFromDisk(editor.profile.id);
      const loaded = await loadProfiles();
      profiles.value = loaded;
      if (selectedProfile.value === editor.savedProfile.name) {
        selectedProfile.value = loaded.find((p) => p.name === "Codfish")?.name ?? loaded[0]?.name ?? "Codfish";
      }
      setEditor(null);
      setSelectedId(null);
    } catch (e) {
      showError(String(e));
    }
  };

  const handleImport = async () => {
    if (!(await guardLeave())) return;
    try {
      const imported = await importProfile();
      if (imported) {
        const loaded = await loadProfiles();
        profiles.value = loaded;
        const found = loaded.find((p) => p.id === imported.id);
        if (found) selectProfile(found);
      }
    } catch (e) {
      showError(String(e));
    }
  };

  const handleExport = async () => {
    if (!editor) return;
    try {
      await exportProfile(editor.profile.id);
    } catch (e) {
      showError(String(e));
    }
  };

  // ── Edit helpers ──────────────────────────────────────────────────────────

  const updateProfile = (updater: (p: CaptionProfile) => void) => {
    if (!editor || editor.readonly) return;
    const updated = cloneProfile(editor.profile);
    updater(updated);
    setEditor({ ...editor, profile: updated });
  };

  const setRule = <T,>(
    section: "timing" | "formatting",
    key: string,
    field: "value" | "strict",
    val: T,
  ) => {
    updateProfile((p) => {
      const sec = p[section] as unknown as Record<string, ProfileRule<unknown>>;
      sec[key] = { ...sec[key], [field]: val };
    });
  };

  const setTimedUnit = (key: "minDuration" | "maxDuration" | "minGapSeconds", newUnit: "s" | "fr") => {
    updateProfile((p) => {
      const rule = p.timing[key] as TimedRule;
      const fps = p.timing.defaultFps;
      const converted = newUnit === "fr"
        ? Math.round(rule.value * fps)
        : Math.round((rule.value / fps) * 1000) / 1000;
      p.timing[key] = { ...rule, value: converted, unit: newUnit } as TimedRule;
    });
  };

  const setPlain = (
    section: "timing" | "formatting" | "merge",
    key: string,
    val: unknown,
  ) => {
    updateProfile((p) => {
      (p[section] as unknown as Record<string, unknown>)[key] = val;
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (!isOpen) return null;

  const builtins = allProfiles.filter((p) => p.builtIn);
  const custom = allProfiles.filter((p) => !p.builtIn);
  const dirty = isDirty();
  const nameError = editor && !editor.readonly ? getNameError(editor.profile.name, editor.profile.id) : null;

  const renderListItem = (p: CaptionProfile) => (
    <button
      key={p.id}
      class={`fmt-list-item${selectedId === p.id ? " fmt-list-item--active" : ""}`}
      onClick={() => handleListClick(p)}
    >
      <span class="fmt-list-item-name">{p.name}</span>
      {selectedId === p.id && dirty && <span class="fmt-list-item-dot" aria-label="Unsaved changes" />}
    </button>
  );

  // Computed bounds for the currently-editing profile
  const t = editor?.profile.timing;
  const f = editor?.profile.formatting;
  const m = editor?.profile.merge;

  const timedToSec = (rule: TimedRule, fps: number) =>
    rule.unit === "fr" ? rule.value / fps : rule.value;

  let minDurMax = 0, maxDurMin = 0, minGapMin = 0, minGapMax = 0;
  if (t) {
    minDurMax = t.minDuration.unit === "fr"
      ? Math.floor(timedToSec(t.maxDuration, t.defaultFps) * t.defaultFps)
      : timedToSec(t.maxDuration, t.defaultFps);
    maxDurMin = t.maxDuration.unit === "fr"
      ? Math.ceil(timedToSec(t.minDuration, t.defaultFps) * t.defaultFps)
      : timedToSec(t.minDuration, t.defaultFps);
    minGapMin = t.minGapSeconds.unit === "fr" ? 1 : 0.05;
    minGapMax = t.minGapSeconds.unit === "fr" ? Math.floor(2 * t.defaultFps) : 2;
  }

  return (
    <div class="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="fmt-manager prof-manager">
        {/* Header */}
        <div class="fmt-manager-header">
          <span class="fmt-manager-title">Caption Profiles</span>
          <button class="btn btn-ghost btn-icon" onClick={close}><X size={14} /></button>
        </div>

        <div class="fmt-manager-body">
          {/* Left pane — Profile list */}
          <div class="fmt-list-pane">
            <div class="fmt-list scrollable">
              {builtins.map(renderListItem)}
              {builtins.length > 0 && custom.length > 0 && (
                <div class="fmt-list-divider" />
              )}
              {custom.map(renderListItem)}
            </div>
            <div class="fmt-list-actions">
              <button class="btn btn-ghost btn-sm" onClick={startNew}><Plus size={12} /> New</button>
              <button class="btn btn-ghost btn-sm" onClick={handleImport}><Import size={12} /> Import</button>
            </div>
          </div>

          {/* Right pane — Editor */}
          <div class="fmt-editor-pane prof-editor-pane">
            {editor && t && f && m ? (
              <>
                <div class="fmt-editor-fields scrollable">
                  {editor.readonly && (
                    <div class="fmt-editor-readonly-banner">
                      <Lock size={12} />
                      <span>Built-in profile — duplicate to customize.</span>
                    </div>
                  )}

                  {/* Name */}
                  <div class="fb-field">
                    <label class="fb-label">Name</label>
                    <input
                      ref={nameRef}
                      class={`fb-input${nameError ? " fb-input--error" : ""}`}
                      type="text"
                      value={editor.profile.name}
                      placeholder="My Profile"
                      disabled={editor.readonly}
                      onInput={(e) => updateProfile((p) => { p.name = (e.target as HTMLInputElement).value; })}
                    />
                    {nameError && <span class="fb-field-error">{nameError}</span>}
                  </div>

                  {/* Formatting */}
                  <Section title="Formatting">
                    <RuleRow
                      label="Max chars / line"
                      desc="Maximum characters per line."
                      value={f.maxCharsPerLine.value}
                      strict={f.maxCharsPerLine.strict}
                      min={20} max={120} step={1}
                      disabled={editor.readonly}
                      onValue={(v) => setRule("formatting", "maxCharsPerLine", "value", v)}
                      onStrict={(s) => setRule("formatting", "maxCharsPerLine", "strict", s)}
                    />
                    <RuleRow
                      label="Max lines"
                      desc="Maximum number of lines per caption."
                      value={f.maxLines.value}
                      strict={f.maxLines.strict}
                      min={1} max={4} step={1}
                      disabled={editor.readonly}
                      onValue={(v) => setRule("formatting", "maxLines", "value", v)}
                      onStrict={(s) => setRule("formatting", "maxLines", "strict", s)}
                    />
                  </Section>

                  {/* Timing */}
                  <Section title="Timing">
                    <RuleRow
                      label="Min duration"
                      desc="Minimum time a caption stays on screen."
                      value={t.minDuration.value}
                      strict={t.minDuration.strict}
                      min={0} max={minDurMax} step={0.1}
                      timedUnit={t.minDuration.unit}
                      disabled={editor.readonly}
                      onValue={(v) => setRule("timing", "minDuration", "value", v)}
                      onStrict={(s) => setRule("timing", "minDuration", "strict", s)}
                      onUnit={(u) => setTimedUnit("minDuration", u)}
                    />
                    <RuleRow
                      label="Max duration"
                      desc="Maximum time a caption stays on screen."
                      value={t.maxDuration.value}
                      strict={t.maxDuration.strict}
                      min={maxDurMin} max={t.maxDuration.unit === "fr" ? Math.floor(20 * t.defaultFps) : 20} step={0.1}
                      timedUnit={t.maxDuration.unit}
                      disabled={editor.readonly}
                      onValue={(v) => setRule("timing", "maxDuration", "value", v)}
                      onStrict={(s) => setRule("timing", "maxDuration", "strict", s)}
                      onUnit={(u) => setTimedUnit("maxDuration", u)}
                    />
                    <RuleRow
                      label="Max CPS"
                      desc="Maximum reading speed in characters per second."
                      value={t.maxCps.value}
                      strict={t.maxCps.strict}
                      min={5} max={30} step={0.1}
                      disabled={editor.readonly}
                      onValue={(v) => setRule("timing", "maxCps", "value", v)}
                      onStrict={(s) => setRule("timing", "maxCps", "strict", s)}
                    />
                    <ToggleRow
                      label="Min gap"
                      desc="Enforce a minimum gap between consecutive captions to prevent flicker."
                      checked={t.minGapEnabled}
                      disabled={editor.readonly}
                      onChange={(v) => setPlain("timing", "minGapEnabled", v)}
                    />
                    {t.minGapEnabled && (
                      <RuleRow
                        label="Min gap duration"
                        desc="Minimum gap between consecutive captions."
                        value={t.minGapSeconds.value}
                        strict={t.minGapSeconds.strict}
                        min={minGapMin} max={minGapMax} step={0.05}
                        timedUnit={t.minGapSeconds.unit}
                        disabled={editor.readonly}
                        onValue={(v) => setRule("timing", "minGapSeconds", "value", v)}
                        onStrict={(s) => setRule("timing", "minGapSeconds", "strict", s)}
                        onUnit={(u) => setTimedUnit("minGapSeconds", u)}
                      />
                    )}
                  </Section>

                  {/* Advanced */}
                  <div class="pe-advanced">
                    <button
                      class="pe-advanced-toggle"
                      onClick={() => setAdvancedOpen(!advancedOpen)}
                    >
                      <span class="pe-advanced-arrow">{advancedOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}</span>
                      Advanced
                    </button>
                    {advancedOpen && (
                      <>
                        <Section title="Timing">
                          <PlainRow
                            label="Gap close threshold"
                            desc="Gaps between spoken words smaller than this are treated as continuous speech — the previous caption extends to fill them seamlessly."
                            value={t.gapCloseThreshold}
                            min={0} max={2} step={0.05}
                            unit="s"
                            disabled={editor.readonly}
                            onChange={(v) => setPlain("timing", "gapCloseThreshold", v)}
                          />
                          <ToggleRow
                            label="Extend to fill"
                            desc="Extend caption end times into silent gaps before the next caption starts."
                            checked={t.extendToFill}
                            disabled={editor.readonly}
                            onChange={(v) => setPlain("timing", "extendToFill", v)}
                          />
                          {t.extendToFill && (
                            <PlainRow
                              label="Extend max"
                              desc="How far to extend a caption end time when filling a gap."
                              value={t.extendToFillMax}
                              min={0} max={2} step={0.05}
                              unit="s"
                              disabled={editor.readonly}
                              onChange={(v) => setPlain("timing", "extendToFillMax", v)}
                            />
                          )}
                          <PlainRow
                            label="FPS"
                            desc="Default frame rate for snapping and timecode display when the media file doesn't report one."
                            value={t.defaultFps}
                            min={1} max={120} step={0.001}
                            disabled={editor.readonly}
                            onChange={(v) => setPlain("timing", "defaultFps", v)}
                          />
                        </Section>

                        <Section title="Segmentation & Merge">
                          <PlainRow
                            label="Phrase break gap"
                            desc="Silence longer than this between words forces a new caption segment."
                            value={m.phraseBreakGap}
                            min={m.enabled ? m.mergeGapThreshold : 0.1} max={3} step={0.05}
                            unit="s"
                            disabled={editor.readonly}
                            onChange={(v) => setPlain("merge", "phraseBreakGap", v)}
                          />
                          <ToggleRow
                            label="Merge short segments"
                            desc="Merge short transcription segments into longer captions."
                            checked={m.enabled}
                            disabled={editor.readonly}
                            onChange={(v) => setPlain("merge", "enabled", v)}
                          />
                          {m.enabled && (
                            <>
                              <PlainRow
                                label="Min segment words"
                                desc="Segments with fewer words than this are candidates for merging."
                                value={m.minSegmentWords}
                                min={1} max={20} step={1}
                                disabled={editor.readonly}
                                onChange={(v) => setPlain("merge", "minSegmentWords", v)}
                              />
                              <PlainRow
                                label="Max merge gap"
                                desc="Maximum gap between two segments that can be merged."
                                value={m.mergeGapThreshold}
                                min={0} max={3} step={0.05}
                                unit="s"
                                disabled={editor.readonly}
                                onChange={(v) => setPlain("merge", "mergeGapThreshold", v)}
                              />
                            </>
                          )}
                        </Section>
                      </>
                    )}
                  </div>
                </div>

                {/* Editor footer */}
                <div class="fmt-editor-footer">
                  {!editor.readonly && (
                    <div style="position:relative">
                      <button
                        class="btn btn-ghost btn-icon"
                        data-tooltip="Delete profile"
                        onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }}
                      >
                        <Trash size={14} />
                      </button>
                      {confirmingDelete && (
                        <div class="fmt-delete-popover" onClick={(e) => e.stopPropagation()}>
                          <span class="fmt-delete-popover-label">Delete this profile?</span>
                          <div class="fmt-delete-popover-actions">
                            <button class="btn btn-ghost btn-sm" onClick={() => setConfirmingDelete(false)}>Cancel</button>
                            <button class="btn btn-danger-ghost btn-sm" onClick={handleDelete}>Delete</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    class="btn btn-ghost btn-icon"
                    data-tooltip="Export .cfp file"
                    onClick={handleExport}
                  >
                    <ExportIcon size={14} />
                  </button>
                  <div style="flex:1" />
                  <button class="btn btn-ghost btn-sm" onClick={handleDuplicate}>
                    <Copy size={12} /> Duplicate
                  </button>
                  {!editor.readonly && (
                    <button class="btn btn-primary btn-sm" onClick={() => performSave()} disabled={!dirty || !!nameError}>
                      Save
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div class="fmt-editor-empty">
                <span class="empty-state-body">Select a profile to view or edit.</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: any }) {
  return (
    <div class="pe-section">
      <div class="pe-section-title">{title}</div>
      {children}
    </div>
  );
}

function NumberInput({ value, min, max, step, unit, disabled, onChange }: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const fmt = (v: number) => v.toFixed(decimals);

  const [raw, setRaw] = useState(fmt(value));

  useEffect(() => { setRaw(fmt(value)); }, [value]);

  const parsed = parseFloat(raw);
  const outOfRange = !isNaN(parsed) && (parsed < min || parsed > max);

  return (
    <input
      type="number"
      class={`pe-number${outOfRange ? " pe-number--error" : ""}`}
      value={raw}
      min={min} max={max} step={step}
      disabled={disabled}
      data-tooltip={rangeTooltip(min, max, unit)}
      onInput={(e) => {
        const s = e.currentTarget.value;
        setRaw(s);
        const v = parseFloat(s);
        if (!isNaN(v)) onChange(v);
      }}
      onBlur={() => {
        const v = parseFloat(raw);
        if (isNaN(v)) { setRaw(fmt(min)); onChange(min); return; }
        const clamped = clamp(v, min, max);
        const stepped = Math.round(clamped / step) * step;
        const final = Math.round(clamp(stepped, min, max) * 1e10) / 1e10;
        setRaw(fmt(final));
        onChange(final);
      }}
      onInvalid={(e) => e.preventDefault()}
    />
  );
}

function RuleRow({ label, desc, value, strict, min, max, step, unit, timedUnit, disabled, onValue, onStrict, onUnit }: {
  label: string;
  desc?: string;
  value: number;
  strict: boolean;
  min: number;
  max: number;
  step: number;
  unit?: string;
  timedUnit?: "s" | "fr";
  disabled?: boolean;
  onValue: (v: number) => void;
  onStrict: (v: boolean) => void;
  onUnit?: (u: "s" | "fr") => void;
}) {
  const isFrames = timedUnit === "fr";
  const displayStep = isFrames ? 1 : step;
  const displayUnit = timedUnit ?? unit;

  return (
    <div class="pe-row">
      <div class="pe-label-wrap">
        <span class="pe-label">{label}</span>
        {desc && <span class="pe-desc">{desc}</span>}
      </div>
      <div class="pe-controls">
        <NumberInput value={value} min={min} max={max} step={displayStep} unit={displayUnit} disabled={disabled} onChange={onValue} />
        {timedUnit && onUnit ? (
          <button
            class="pe-unit-toggle"
            onClick={() => onUnit(isFrames ? "s" : "fr")}
            disabled={disabled}
            data-tooltip={isFrames ? "Switch to seconds" : "Switch to frames"}
          >
            {timedUnit}
          </button>
        ) : (
          displayUnit && <span class="pe-unit">{displayUnit}</span>
        )}
        <button
          class="pe-rule-toggle"
          onClick={() => onStrict(!strict)}
          disabled={disabled}
          data-tooltip={strict ? "Violations flagged as errors" : "Violations flagged as warnings"}
        >
          <span class={`pe-rule-dot ${strict ? "pe-rule-dot--error" : "pe-rule-dot--warning"}`} />
          {strict ? "Error" : "Warning"}
        </button>
      </div>
    </div>
  );
}

function PlainRow({ label, desc, value, min, max, step, unit, disabled, onChange }: {
  label: string;
  desc?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div class="pe-row">
      <div class="pe-label-wrap">
        <span class="pe-label">{label}</span>
        {desc && <span class="pe-desc">{desc}</span>}
      </div>
      <div class="pe-controls">
        <NumberInput value={value} min={min} max={max} step={step} unit={unit} disabled={disabled} onChange={onChange} />
        {unit && <span class="pe-unit">{unit}</span>}
      </div>
    </div>
  );
}

function ToggleRow({ label, desc, checked, disabled, onChange }: {
  label: string;
  desc?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div class="pe-row">
      <div class="pe-label-wrap">
        <span class="pe-label">{label}</span>
        {desc && <span class="pe-desc">{desc}</span>}
      </div>
      <div class="pe-controls">
        <button
          class={`pe-toggle ${checked ? "pe-toggle--on" : ""}`}
          disabled={disabled}
          onClick={() => onChange(!checked)}
        >
          {checked ? "On" : "Off"}
        </button>
      </div>
    </div>
  );
}
