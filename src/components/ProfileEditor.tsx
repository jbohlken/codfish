import { signal } from "@preact/signals";
import { profiles, activeProfile, project, pushHistory } from "../store/app";
import type { CaptionProfile, ProfileRule } from "../types/profile";

export const profileEditorOpen = signal(false);

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
    // Built-in profiles are read-only — fork a copy first
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
          <button class="btn btn-ghost btn-icon" onClick={close}>✕</button>
        </div>

        <div class="profile-editor-body">
          {/* ── Formatting ─────────────────────────────────────────────── */}
          <Section title="Formatting">
            <RuleRow
              label="Max chars / line"
              value={f.maxCharsPerLine.value}
              strict={f.maxCharsPerLine.strict}
              min={20} max={100} step={1}
              onValue={(v) => setRule("formatting", "maxCharsPerLine", "value", v)}
              onStrict={(s) => setRule("formatting", "maxCharsPerLine", "strict", s)}
            />
            <PlainRow
              label="Max lines"
              value={f.maxLines}
              min={1} max={4} step={1}
              onChange={(v) => setPlain("formatting", "maxLines", v)}
              note="always strict"
            />
            <RuleRow
              label="Max CPS"
              value={f.maxCps.value}
              strict={f.maxCps.strict}
              min={5} max={50} step={0.5}
              onValue={(v) => setRule("formatting", "maxCps", "value", v)}
              onStrict={(s) => setRule("formatting", "maxCps", "strict", s)}
            />
          </Section>

          {/* ── Timing ─────────────────────────────────────────────────── */}
          <Section title="Timing">
            <RuleRow
              label="Min duration"
              value={t.minDuration.value}
              strict={t.minDuration.strict}
              min={0} max={5} step={0.1}
              unit="s"
              onValue={(v) => setRule("timing", "minDuration", "value", v)}
              onStrict={(s) => setRule("timing", "minDuration", "strict", s)}
            />
            <RuleRow
              label="Max duration"
              value={t.maxDuration.value}
              strict={t.maxDuration.strict}
              min={1} max={20} step={0.5}
              unit="s"
              onValue={(v) => setRule("timing", "maxDuration", "value", v)}
              onStrict={(s) => setRule("timing", "maxDuration", "strict", s)}
            />
            <PlainRow
              label="Min gap"
              value={t.minGapSeconds}
              min={0} max={2} step={0.05}
              unit="s"
              onChange={(v) => setPlain("timing", "minGapSeconds", v)}
              note="always strict"
            />
            <PlainRow
              label="Gap close threshold"
              value={t.gapCloseThreshold}
              min={0} max={2} step={0.05}
              unit="s"
              onChange={(v) => setPlain("timing", "gapCloseThreshold", v)}
            />
            <ToggleRow
              label="Extend to fill"
              checked={t.extendToFill}
              onChange={(v) => setPlain("timing", "extendToFill", v)}
            />
            {t.extendToFill && (
              <PlainRow
                label="Extend max"
                value={t.extendToFillMax}
                min={0} max={2} step={0.05}
                unit="s"
                onChange={(v) => setPlain("timing", "extendToFillMax", v)}
              />
            )}
            <PlainRow
              label="FPS"
              value={t.defaultFps}
              min={1} max={120} step={0.001}
              onChange={(v) => setPlain("timing", "defaultFps", v)}
            />
          </Section>

          {/* ── Merge ──────────────────────────────────────────────────── */}
          <Section title="Segmentation & Merge">
            <ToggleRow
              label="Merge short segments"
              checked={m.enabled}
              onChange={(v) => setPlain("merge", "enabled", v)}
            />
            {m.enabled && (
              <>
                <PlainRow
                  label="Min segment words"
                  value={m.minSegmentWords}
                  min={1} max={20} step={1}
                  onChange={(v) => setPlain("merge", "minSegmentWords", v)}
                />
                <PlainRow
                  label="Max merge gap"
                  value={m.mergeGapThreshold}
                  min={0} max={3} step={0.05}
                  unit="s"
                  onChange={(v) => setPlain("merge", "mergeGapThreshold", v)}
                />
                <PlainRow
                  label="Max merged chars"
                  value={m.maxMergedChars}
                  min={20} max={200} step={1}
                  onChange={(v) => setPlain("merge", "maxMergedChars", v)}
                />
                <PlainRow
                  label="Max merged duration"
                  value={m.maxMergedDuration}
                  min={1} max={20} step={0.5}
                  unit="s"
                  onChange={(v) => setPlain("merge", "maxMergedDuration", v)}
                />
              </>
            )}
          </Section>
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

function RuleRow({ label, value, strict, min, max, step, unit, onValue, onStrict }: {
  label: string;
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
      <label class="pe-label">{label}</label>
      <div class="pe-controls">
        <input
          type="number"
          class="pe-number"
          value={value}
          min={min} max={max} step={step}
          onInput={(e) => onValue(parseFloat(e.currentTarget.value))}
        />
        {unit && <span class="pe-unit">{unit}</span>}
        <button
          class={`pe-rule-toggle ${strict ? "pe-rule-toggle--strict" : "pe-rule-toggle--fuzzy"}`}
          onClick={() => onStrict(!strict)}
          title={strict ? "Strict: pipeline enforces this limit" : "Fuzzy: warn only, not enforced"}
        >
          {strict ? "Strict" : "Fuzzy"}
        </button>
      </div>
    </div>
  );
}

function PlainRow({ label, value, min, max, step, unit, note, onChange }: {
  label: string;
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
      <label class="pe-label">{label}</label>
      <div class="pe-controls">
        <input
          type="number"
          class="pe-number"
          value={value}
          min={min} max={max} step={step}
          onInput={(e) => onChange(parseFloat(e.currentTarget.value))}
        />
        {unit && <span class="pe-unit">{unit}</span>}
        {note && <span class="pe-note">{note}</span>}
      </div>
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div class="pe-row">
      <label class="pe-label">{label}</label>
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
