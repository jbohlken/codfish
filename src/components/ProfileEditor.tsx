import { signal } from "@preact/signals";
import { useState, useEffect } from "preact/hooks";
import { XIcon as X, CaretRightIcon as CaretRight, CaretDownIcon as CaretDown } from "@phosphor-icons/react";
import { profiles, activeProfile, project, pushHistory } from "../store/app";
import type { CaptionProfile, ProfileRule } from "../types/profile";

export const profileEditorOpen = signal(false);
const advancedOpen = signal(false);

// ── Helpers ───────────────────────────────────────────────────────────────────

function cloneProfile(p: CaptionProfile): CaptionProfile {
  return JSON.parse(JSON.stringify(p));
}

function makeUserCopy(p: CaptionProfile): CaptionProfile {
  return {
    ...cloneProfile(p),
    id: `user_${Date.now()}`,
    name: `${p.name} (copy)`,
    builtIn: false,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ProfileEditor() {
  if (!profileEditorOpen.value) return null;

  const profile = activeProfile.value;
  const isBuiltIn = profile.builtIn;

  const close = () => { profileEditorOpen.value = false; };

  const edit = (updater: (p: CaptionProfile) => void) => {
    let target: CaptionProfile;
    if (isBuiltIn) {
      target = makeUserCopy(profile);
      profiles.value = [...profiles.value, target];
      if (project.value) {
        pushHistory({ ...project.value, profileId: target.id });
      }
    } else {
      target = cloneProfile(profile);
      updater(target);
      profiles.value = profiles.value.map((p) => p.id === target.id ? target : p);
      return;
    }
    updater(target);
    profiles.value = profiles.value.map((p) => p.id === target.id ? target : p);
  };

  const setRule = <T,>(
    section: "timing" | "formatting",
    key: string,
    field: "value" | "strict",
    val: T,
  ) => {
    edit((p) => {
      const sec = p[section] as unknown as Record<string, ProfileRule<unknown>>;
      sec[key] = { ...sec[key], [field]: val };
    });
  };

  const setPlain = (
    section: "timing" | "formatting" | "merge",
    key: string,
    val: unknown,
  ) => {
    edit((p) => {
      (p[section] as unknown as Record<string, unknown>)[key] = val;
    });
  };

  const handleRename = (name: string) => {
    if (isBuiltIn) return;
    profiles.value = profiles.value.map((p) =>
      p.id === profile.id ? { ...p, name } : p
    );
  };

  const handleDelete = () => {
    if (isBuiltIn || profiles.value.length <= 1) return;
    const remaining = profiles.value.filter((p) => p.id !== profile.id);
    profiles.value = remaining;
    if (project.value) {
      pushHistory({ ...project.value, profileId: remaining[0].id });
    }
  };

  const t = profile.timing;
  const f = profile.formatting;
  const m = profile.merge;

  return (
    <div class="modal-backdrop" onClick={close}>
      <div class="profile-editor" onClick={(e) => e.stopPropagation()}>
        <div class="profile-editor-header">
          <div class="profile-editor-title-row">
            {isBuiltIn ? (
              <span class="profile-editor-title">{profile.name}</span>
            ) : (
              <input
                class="profile-editor-name-input"
                value={profile.name}
                onInput={(e) => handleRename(e.currentTarget.value)}
              />
            )}
            {isBuiltIn && (
              <span class="profile-editor-badge">Built-in · read-only (edits fork a copy)</span>
            )}
          </div>
          <button class="btn btn-ghost btn-icon" onClick={close}><X size={14} /></button>
        </div>

        <div class="profile-editor-body">
          {/* ── Formatting ─────────────────────────────────────────────── */}
          <Section title="Formatting">
            <RuleRow
              label="Max chars / line"
              desc="Maximum characters per line — used as a target when breaking lines."
              value={f.maxCharsPerLine.value}
              strict={f.maxCharsPerLine.strict}
              min={20} max={120} step={1}
              onValue={(v) => setRule("formatting", "maxCharsPerLine", "value", v)}
              onStrict={(s) => setRule("formatting", "maxCharsPerLine", "strict", s)}
            />
            <PlainRow
              label="Max lines"
              desc="Maximum number of lines per caption."
              value={f.maxLines}
              min={1} max={4} step={1}
              onChange={(v) => setPlain("formatting", "maxLines", v)}
              note="always strict"
            />
            <RuleRow
              label="Max CPS"
              desc="Maximum reading speed in characters per second."
              value={f.maxCps.value}
              strict={f.maxCps.strict}
              min={5} max={30} step={0.1}
              onValue={(v) => setRule("formatting", "maxCps", "value", v)}
              onStrict={(s) => setRule("formatting", "maxCps", "strict", s)}
            />
          </Section>

          {/* ── Timing ─────────────────────────────────────────────────── */}
          <Section title="Timing">
            <RuleRow
              label="Min duration"
              desc="Minimum time a caption stays on screen."
              value={t.minDuration.value}
              strict={t.minDuration.strict}
              min={0} max={5} step={0.1}
              unit="s"
              onValue={(v) => setRule("timing", "minDuration", "value", v)}
              onStrict={(s) => setRule("timing", "minDuration", "strict", s)}
            />
            <RuleRow
              label="Max duration"
              desc="Maximum time a caption stays on screen."
              value={t.maxDuration.value}
              strict={t.maxDuration.strict}
              min={1} max={20} step={0.5}
              unit="s"
              onValue={(v) => setRule("timing", "maxDuration", "value", v)}
              onStrict={(s) => setRule("timing", "maxDuration", "strict", s)}
            />
            <ToggleRow
              label="Min gap"
              desc="Enforce a minimum gap between consecutive captions to prevent flicker."
              checked={t.minGapEnabled}
              onChange={(v) => setPlain("timing", "minGapEnabled", v)}
            />
            {t.minGapEnabled && (
              <RuleRow
                label="Min gap duration"
                desc="Minimum gap between consecutive captions."
                value={t.minGapSeconds.value}
                strict={t.minGapSeconds.strict}
                min={0.05} max={2} step={0.05}
                unit="s"
                onValue={(v) => setRule("timing", "minGapSeconds", "value", v)}
                onStrict={(s) => setRule("timing", "minGapSeconds", "strict", s)}
              />
            )}
          </Section>

          {/* ── Advanced ───────────────────────────────────────────────── */}
          <div class="pe-advanced">
            <button
              class="pe-advanced-toggle"
              onClick={() => { advancedOpen.value = !advancedOpen.value; }}
            >
              <span class="pe-advanced-arrow">{advancedOpen.value ? <CaretDown size={12} /> : <CaretRight size={12} />}</span>
              Advanced
            </button>
            {advancedOpen.value && (
              <>
                <Section title="Timing">
                  <PlainRow
                    label="Gap close threshold"
                    desc="Gaps between spoken words smaller than this are treated as continuous speech — the previous caption extends to fill them seamlessly."
                    value={t.gapCloseThreshold}
                    min={0} max={2} step={0.05}
                    unit="s"
                    onChange={(v) => setPlain("timing", "gapCloseThreshold", v)}
                  />
                  <ToggleRow
                    label="Extend to fill"
                    desc="Extend caption end times into silent gaps before the next caption starts."
                    checked={t.extendToFill}
                    onChange={(v) => setPlain("timing", "extendToFill", v)}
                  />
                  {t.extendToFill && (
                    <PlainRow
                      label="Extend max"
                      desc="How far to extend a caption end time when filling a gap."
                      value={t.extendToFillMax}
                      min={0} max={2} step={0.05}
                      unit="s"
                      onChange={(v) => setPlain("timing", "extendToFillMax", v)}
                    />
                  )}
                  <PlainRow
                    label="FPS"
                    desc="Default frame rate for snapping and timecode display when the media file doesn't report one."
                    value={t.defaultFps}
                    min={1} max={120} step={0.001}
                    onChange={(v) => setPlain("timing", "defaultFps", v)}
                  />
                </Section>

                <Section title="Segmentation & Merge">
                  <ToggleRow
                    label="Merge short segments"
                    desc="Merge short transcription segments into longer captions."
                    checked={m.enabled}
                    onChange={(v) => setPlain("merge", "enabled", v)}
                  />
                  {m.enabled && (
                    <>
                      <PlainRow
                        label="Min segment words"
                        desc="Segments with fewer words than this are candidates for merging."
                        value={m.minSegmentWords}
                        min={1} max={20} step={1}
                        onChange={(v) => setPlain("merge", "minSegmentWords", v)}
                      />
                      <PlainRow
                        label="Max merge gap"
                        desc="Maximum gap between two segments that can be merged."
                        value={m.mergeGapThreshold}
                        min={0} max={3} step={0.05}
                        unit="s"
                        onChange={(v) => setPlain("merge", "mergeGapThreshold", v)}
                      />
                      <PlainRow
                        label="Max merged chars"
                        desc="Maximum characters in a merged caption."
                        value={m.maxMergedChars}
                        min={20} max={200} step={1}
                        onChange={(v) => setPlain("merge", "maxMergedChars", v)}
                      />
                      <PlainRow
                        label="Max merged duration"
                        desc="Maximum duration of a merged caption."
                        value={m.maxMergedDuration}
                        min={1} max={20} step={0.5}
                        unit="s"
                        onChange={(v) => setPlain("merge", "maxMergedDuration", v)}
                      />
                    </>
                  )}
                </Section>
              </>
            )}
          </div>
        </div>

        {!isBuiltIn && (
          <div class="profile-editor-footer">
            <button
              class="btn btn-danger-ghost"
              onClick={handleDelete}
              disabled={profiles.value.length <= 1}
            >
              Delete profile
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: any }) {
  return (
    <div class="pe-section">
      <div class="pe-section-title">{title}</div>
      {children}
    </div>
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function rangeTooltip(min: number, max: number, unit?: string): string {
  const u = unit ? ` ${unit}` : "";
  return `${min}–${max}${u}`;
}

function NumberInput({ value, min, max, step, unit, onChange }: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  const [raw, setRaw] = useState(String(value));

  // Sync when external value changes (e.g. profile switch)
  useEffect(() => { setRaw(String(value)); }, [value]);

  const parsed = parseFloat(raw);
  const outOfRange = !isNaN(parsed) && (parsed < min || parsed > max);

  return (
    <input
      type="number"
      class={`pe-number${outOfRange ? " pe-number--error" : ""}`}
      value={raw}
      min={min} max={max} step={step}
      data-tooltip={rangeTooltip(min, max, unit)}
      onInput={(e) => {
        const s = e.currentTarget.value;
        setRaw(s);
        const v = parseFloat(s);
        if (!isNaN(v)) onChange(v);
      }}
      onBlur={() => {
        const v = parseFloat(raw);
        if (isNaN(v)) { setRaw(String(min)); onChange(min); return; }
        const clamped = clamp(v, min, max);
        const stepped = Math.round(clamped / step) * step;
        const final = Math.round(clamp(stepped, min, max) * 1e10) / 1e10;
        setRaw(String(final));
        onChange(final);
      }}
      onInvalid={(e) => e.preventDefault()}
    />
  );
}

function RuleRow({ label, desc, value, strict, min, max, step, unit, onValue, onStrict }: {
  label: string;
  desc?: string;
  value: number;
  strict: boolean;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onValue: (v: number) => void;
  onStrict: (v: boolean) => void;
}) {
  return (
    <div class="pe-row">
      <div class="pe-label-wrap">
        <span class="pe-label">{label}</span>
        {desc && <span class="pe-desc">{desc}</span>}
      </div>
      <div class="pe-controls">
        <NumberInput value={value} min={min} max={max} step={step} unit={unit} onChange={onValue} />
        {unit && <span class="pe-unit">{unit}</span>}
        <button
          class="pe-rule-toggle"
          onClick={() => onStrict(!strict)}
          data-tooltip={strict ? "Violations flagged as errors" : "Violations flagged as warnings"}
        >
          <span class={`pe-rule-dot ${strict ? "pe-rule-dot--error" : "pe-rule-dot--warning"}`} />
          {strict ? "Error" : "Warning"}
        </button>
      </div>
    </div>
  );
}

function PlainRow({ label, desc, value, min, max, step, unit, note, onChange }: {
  label: string;
  desc?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  note?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div class="pe-row">
      <div class="pe-label-wrap">
        <span class="pe-label">{label}</span>
        {desc && <span class="pe-desc">{desc}</span>}
      </div>
      <div class="pe-controls">
        <NumberInput value={value} min={min} max={max} step={step} unit={unit} onChange={onChange} />
        {unit && <span class="pe-unit">{unit}</span>}
        {note && <span class="pe-note">{note}</span>}
      </div>
    </div>
  );
}

function ToggleRow({ label, desc, checked, onChange }: {
  label: string;
  desc?: string;
  checked: boolean;
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
          onClick={() => onChange(!checked)}
        >
          {checked ? "On" : "Off"}
        </button>
      </div>
    </div>
  );
}
