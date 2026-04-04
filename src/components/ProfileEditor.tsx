import { signal } from "@preact/signals";
import { useState, useEffect } from "preact/hooks";
import { XIcon as X, CaretRightIcon as CaretRight, CaretDownIcon as CaretDown } from "@phosphor-icons/react";
import { profiles, activeProfile, project, pushHistory } from "../store/app";
import type { CaptionProfile, ProfileRule, TimedRule } from "../types/profile";
import { saveProfile as saveProfileToDisk, deleteProfile as deleteProfileFromDisk } from "../lib/profiles";

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
      updater(target);
      profiles.value = [...profiles.value, target];
      if (project.value) {
        pushHistory({ ...project.value, profileId: target.id });
      }
    } else {
      target = cloneProfile(profile);
      updater(target);
      profiles.value = profiles.value.map((p) => p.id === target.id ? target : p);
    }
    saveProfileToDisk(target);
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

  const setTimedUnit = (key: "minDuration" | "maxDuration" | "minGapSeconds", newUnit: "s" | "fr") => {
    edit((p) => {
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
    edit((p) => {
      (p[section] as unknown as Record<string, unknown>)[key] = val;
    });
  };

  const handleRename = (name: string) => {
    if (isBuiltIn) return;
    const updated = { ...profile, name };
    profiles.value = profiles.value.map((p) =>
      p.id === profile.id ? updated : p
    );
    saveProfileToDisk(updated);
  };

  const handleDelete = () => {
    if (isBuiltIn || profiles.value.length <= 1) return;
    const remaining = profiles.value.filter((p) => p.id !== profile.id);
    profiles.value = remaining;
    deleteProfileFromDisk(profile.id);
    if (project.value) {
      pushHistory({ ...project.value, profileId: remaining[0].id });
    }
  };

  const t = profile.timing;
  const f = profile.formatting;
  const m = profile.merge;

  // Convert a TimedRule to seconds using the profile's defaultFps
  const timedToSec = (rule: TimedRule) =>
    rule.unit === "fr" ? rule.value / t.defaultFps : rule.value;

  // Cross-field bounds for duration fields (in each field's own unit)
  const minDurMax = t.minDuration.unit === "fr"
    ? Math.floor(timedToSec(t.maxDuration) * t.defaultFps)
    : timedToSec(t.maxDuration);
  const maxDurMin = t.maxDuration.unit === "fr"
    ? Math.ceil(timedToSec(t.minDuration) * t.defaultFps)
    : timedToSec(t.minDuration);

  // Min gap bounds in its own unit
  const minGapMin = t.minGapSeconds.unit === "fr" ? 1 : 0.05;
  const minGapMax = t.minGapSeconds.unit === "fr" ? Math.floor(2 * t.defaultFps) : 2;

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
              desc="Maximum characters per line."
              value={f.maxCharsPerLine.value}
              strict={f.maxCharsPerLine.strict}
              min={20} max={120} step={1}
              onValue={(v) => setRule("formatting", "maxCharsPerLine", "value", v)}
              onStrict={(s) => setRule("formatting", "maxCharsPerLine", "strict", s)}
            />
            <RuleRow
              label="Max lines"
              desc="Maximum number of lines per caption."
              value={f.maxLines.value}
              strict={f.maxLines.strict}
              min={1} max={4} step={1}
              onValue={(v) => setRule("formatting", "maxLines", "value", v)}
              onStrict={(s) => setRule("formatting", "maxLines", "strict", s)}
            />
          </Section>

          {/* ── Timing ─────────────────────────────────────────────────── */}
          <Section title="Timing">
            <RuleRow
              label="Min duration"
              desc="Minimum time a caption stays on screen."
              value={t.minDuration.value}
              strict={t.minDuration.strict}
              min={0} max={minDurMax} step={0.1}
              timedUnit={t.minDuration.unit}
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
              onValue={(v) => setRule("timing", "maxCps", "value", v)}
              onStrict={(s) => setRule("timing", "maxCps", "strict", s)}
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
                min={minGapMin} max={minGapMax} step={0.05}
                timedUnit={t.minGapSeconds.unit}
                onValue={(v) => setRule("timing", "minGapSeconds", "value", v)}
                onStrict={(s) => setRule("timing", "minGapSeconds", "strict", s)}
                onUnit={(u) => setTimedUnit("minGapSeconds", u)}
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
                  <PlainRow
                    label="Phrase break gap"
                    desc="Silence longer than this between words forces a new caption segment."
                    value={m.phraseBreakGap}
                    min={m.enabled ? m.mergeGapThreshold : 0.1} max={3} step={0.05}
                    unit="s"
                    onChange={(v) => setPlain("merge", "phraseBreakGap", v)}
                  />
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
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const fmt = (v: number) => v.toFixed(decimals);

  const [raw, setRaw] = useState(fmt(value));

  // Sync when external value changes (e.g. profile switch)
  useEffect(() => { setRaw(fmt(value)); }, [value]);

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

function RuleRow({ label, desc, value, strict, min, max, step, unit, timedUnit, onValue, onStrict, onUnit }: {
  label: string;
  desc?: string;
  value: number;
  strict: boolean;
  min: number;
  max: number;
  step: number;
  unit?: string;
  timedUnit?: "s" | "fr";
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
        <NumberInput value={value} min={min} max={max} step={displayStep} unit={displayUnit} onChange={onValue} />
        {timedUnit && onUnit ? (
          <button
            class="pe-unit-toggle"
            onClick={() => onUnit(isFrames ? "s" : "fr")}
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
