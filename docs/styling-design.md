# Codfish styling — design & roadmap (0.7.0)

0.7.0 ships when styling is COMPLETE, as defined here. Governing principle:
the MODEL stays agnostic to export formats — it stores semantics; each
format's .cff decides what those semantics look like, and formats that
can't express something say so (never silently).

Revision note: this version folds in the adversarial design panel's
findings (2026-07-07, 13 confirmed majors → 8 design gaps, all resolved
below; no locked decision was relitigated).

## The organizing idea: three layers

Everything in caption styling falls into one of three layers, and the layer
determines where it lives in the model:

1. **Run-level** — properties of a stretch of TEXT within a cue.
   Model: spans ({line, start, end, style, value?}). DONE for
   emphasis/strong/underline; classes are the remaining run-level feature.
2. **Block-level** — properties of a whole CUE: where it sits, how its
   lines align. Model: new optional fields on CaptionBlock (NOT spans —
   position has no text anchor). This is the position feature.
3. **Project-level** — DEFINITIONS the other two layers reference: what a
   class named "narrator" looks like. Model: new optional field on the
   project (travels in .cod; appearance must not bleed across projects).

The preview pipeline mirrors the layers: stock sheet → user preview CSS
(app-level "theme") → generated project sheet (class appearances) → per-cue
position applied to the overlay. The slot registry in captionPreviewCss.ts
already reserves the project slot.

## Feature: classes (run-level + project-level)

### Model

Span: `{style: "class", value: "<name>"}`. Project: `classes?: CaptionClass[]`:

    interface CaptionClass {
      name: string;          // ^[A-Za-z_][A-Za-z0-9_-]*$ — CSS-ident-safe
                             // (no leading digit/hyphen: ::cue(.1red) is an
                             // INVALID selector even though <c.1red> is legal
                             // VTT; TTML xml:id has the same restriction)
      color?: string;        // pinned format: lowercase #rrggbb or #rrggbbaa
      background?: string;   // same pinned format
      emphasis?: boolean;    // reuse the semantic keys, not "italic"
      strong?: boolean;
      underline?: boolean;
      // deliberately structured, NOT raw CSS — the agnosticism linchpin.
      // Each exporter translates properties it understands.
    }

Why structured properties and not raw CSS: raw CSS is only meaningful to
VTT STYLE blocks and burn-in. TTML wants tts: attributes, ASS wants a
[V4+ Styles] line, SRT wants <font color>. Structured props translate to
all of them; raw CSS translates to one.

Names are unique **case-insensitively** (creating/renaming to a name that
differs from an existing one only by case is rejected — "Red" vs "red" is
a usability trap even though both are technically valid). Colors are
normalized to the pinned format at creation; free-form strings are never
stored (SRT wants #hex, ASS wants &HBBGGRR — translation needs a known
source format).

**Nesting.** Class goes OUTERMOST in STYLE_ORDER (`<c.x><i>…</i></c>`).
Safe: no persisted file can yet contain the key, so prepending changes no
existing canonical ordering. The "append, never reorder" comments in
lib/spans.ts get updated in the same commit to state the REAL invariant:
never change the relative order of existing keys; insertion position is
otherwise free. Add a cross-version round-trip test (0.7.0 .cod with
class+emphasis spans loaded by the old sort → harmless reorder, no loss).

### Lifecycle (all four operations specified — this is model integrity)

- **Create** (manager "new class…" or the swatch flow): validated name,
  normalized color. Swatch auto-create commits the definition TOGETHER
  with the span application in ONE pushHistory entry — cancelling the edit
  session before applying never creates the definition; undo removes both.
- **Rename**: rewrites every matching span value across every caption of
  every media item, atomically in ONE pushHistory entry (safe: spansHash
  covers lines only; history snapshots the whole project). A rename that
  only edits the definition is a forbidden implementation — dangling names
  render unstyled and export wrong silently.
- **Delete**: strips all matching spans in the same history entry, after a
  usage confirmation ("Delete 'narrator'? Used in 12 captions.").
- **Duplicate color pick**: picking a color that exactly matches an
  existing AUTO-CREATED swatch class reuses it (no red-2 junk drawer);
  renaming a swatch promotes it out of the reuse pool.

**Load-time sanitization** (both ingestion paths, like spans already get —
.cod files travel between machines and are untrusted):
- definitions with invalid names/colors or duplicate names → dropped;
- class spans with a missing or invalid value → dropped (a valueless
  class span must NEVER be treated as a plain editable span —
  isEditorEditableSpan special-cases style==="class" regardless of value);
- class spans referencing a missing definition are KEPT (the name is still
  meaning) but render unstyled, export with all property tokens absent,
  and count toward the dropped-styling notice.

### Editor mechanism (decision: commit-then-apply — real work, not a seam)

The contenteditable's round-trip contract deliberately excludes
value-bearing spans, and its popover survives only because its buttons
never take focus. Classes therefore do NOT enter the editing session:

- The popover grows ONE "class" button opening an anchored PANEL
  (portal-rendered above the list so it can't clip) that: suppresses the
  editor's blur-commit for its lifetime, and captures the selection range
  (as model offsets) when it opens.
- Choosing a class (or picking a swatch color): the session COMMITS first
  (normal commit path, selection offsets mapped through renormalization),
  then the class span is applied to the committed model — with the
  auto-created definition when it's a new swatch — as one history entry.
  The edit session ends; re-enter to keep typing. (Applying a class is a
  terminal styling action; mid-word application isn't a real workflow.)
- Swatch UI: prototype the native color input's focus behavior on
  WebView2 AND WKWebView before committing to it; the fallback is a fixed
  palette of app-drawn swatch buttons (no focus) with "custom…" opening
  the inline management panel.

**Text-edit survival rule** (the panel's sharpest catch — without this,
fixing a typo silently deletes a just-applied class): on commit with
changed text, preserved value-bearing spans are REMAPPED through a single
splice computed from the longest common prefix/suffix of the joined
old/new text (the same remapSpansThroughSplices machinery replace uses).
Spans outside the replaced middle survive shifted; spans entirely inside
it drop (their anchor text is gone). The live overlay during editing
composites preserved class spans through the same cheap remap so class
coloring doesn't vanish while typing.

### Class management UI (decision: NO fourth manager modal)

Class definitions are PROJECT data: edits are immediate, dirty the project
normally, and are undoable via pushHistory. A guarded manager modal would
contradict all of that (undo is disabled inside modals; the request-close
guard chains grow quadratically) AND contradict the swatch flow, which is
already an immediate project edit. So: lightweight management lives inline
in the class picker panel (rename, recolor, delete — each an immediate
one-history-entry action, no dirty buffer, no guard, no App.tsx wiring).
A full management surface belongs to the future project-settings home.

### Preview

Generated sheet from `classes` → the reserved "project-classes" slot.
Selectors are NOT scoped to the overlay: `[data-style="class"][data-value="narrator"] { … }`
— classes color the caption list rows and timeline labels too, exactly
like emphasis/bold render there today. Built via CSSOM (setProperty +
CSS.escape), never string assembly, and containment-checked like the user
sheet (defense in depth — .cod is foreign input). The sheet is DERIVED
reactively from project.value: regenerates on any project change
(including undo/redo, which can restore definitions) and clears on
project close — never "on load and on class edits" bookkeeping.

### Export

1. Run mapping: `class: { open: "<c.{{value}}>", close: "</c>" }`.
   The mapping's token context includes the RESOLVED definition:
   {{value}} (name) plus {{color}}, {{background}}, and the booleans as
   presence-sections. srt.cff:
   `class: { open: "{{#color}}<font color=\"{{color}}\">{{/color}}", close: "{{#color}}</font>{{/color}}" }`
   — presence sections (see Grammar) make optional properties safe; a
   missing definition resolves all property sections absent.
2. Header emission: `{{#classes}}…{{/classes}}` iterates definitions with
   the same tokens/sections, so vtt.cff writes its STYLE block:

       {{#classes}}
       STYLE
       ::cue(.{{name}}) { {{#color}}color: {{color}};{{/color}} {{#strong}}font-weight: bold;{{/strong}} … }
       {{/classes}}

   (VTT permits multiple STYLE blocks, so per-class emission is valid.
   A once-if-nonempty wrapper construct for TTML-style single headers is
   a known future grammar addition, not Phase 7 scope.)

## Feature: position (block-level)

### Model

`CaptionBlock.position?: CuePosition`, all fields optional (absent =
today's default placement):

    interface CuePosition {
      line?: number;      // vertical anchor, % of video height (0=top)
      position?: number;  // HORIZONTAL CENTER of the block, % of width
      align?: "start" | "center" | "end";   // text alignment in the block
      size?: number;      // block width, % of width
    }

**Semantics pin (panel finding): `position` is the block's CENTER,
unconditionally** — intuitive for presets/drag and for the preview math.
This deliberately differs from raw VTT, where the anchor follows text
alignment; the VTT builtin bridges the gap WITHOUT math by emitting the
explicit center anchor: `position:{{position.position}}%,center`.
Derived tokens serve edge-based formats: `{{position.left}}`
(center − size/2) resolves only when BOTH position and size are present —
TTML-grade formats want explicit sizes. A future VTT IMPORT converts
align-dependent anchors to center semantics in app code at import time
(import is app machinery; the no-format-syntax rule applies to EXPORT).

NOT spans: no text anchor, no spansHash involvement, survives text edits.
- Split: position copies to both halves (verify: splitCaption's `...rest`
  spread already does this — pin with a test).
- Merge: keeps the earlier cue's — mergeCaption builds its block from an
  explicit field list, so this needs an EXPLICIT carry plus a test
  (silently dropped otherwise). Accepted compatibility note: a pre-0.7.x
  app merging captions in a positioned .cod drops that cue's position
  (every other operation there spreads unknown fields and is safe).
- Regeneration: wholesale-replaces captions, so positions are lost like
  every other per-caption edit. DECIDED: consistent and accepted.

### Editor UX

1. Presets: a 10-cell control — the 9-position grid PLUS a "default"
   cell that clears position entirely.
2. "Apply to all captions in this clip" on the preset control (one
   history entry) — the common "whole clip above the lower-third" case.
3. Numeric fine-tuning fields.
4. Drag-the-caption-on-video (Phase 9): an input affordance over the same
   numbers. The interaction spec (row-click already seeks the playhead to
   the cue, so the dragged cue is always visible; pointer-events gate
   while in position mode; pause during drag; live snap to presets;
   single history entry on pointerup; Escape exits) is written at Phase
   8/9 implementation time.

Caption rows get a small position glyph (with a values tooltip) so
positioned cues are discoverable in the list without scrubbing.

### Preview

Position is applied as INLINE STYLE PROPERTIES on the overlay element,
set only when the cue carries position (NOT CSS variables — a var-based
mechanism provably breaks default placement for unpositioned cues and
loses the precedence fight; probes confirmed). Unpositioned cues are
untouched: stock sheet and user preview CSS behave exactly as today.
Locked precedence — cue position (content) beats user preview CSS
(theme) — falls out of inline-style precedence for free; `!important` in
user CSS remains the accepted escape hatch (footgun-guard stance).
Copy updates in the same phase: the preview-CSS worksheet header says
bare declarations style the DEFAULT placement and cues positioned in the
editor override it; one line of UX copy distinguishes "preview theme
(this app only)" from "cue position (exports with your captions)".
Renderer contract stays: ONE active cue at a time (findCaptionAt) — added
to non-goals; overlapping simultaneous cues arrive with import, later.

### Export

Per-cue presence sections and tokens inside {{each}}:
`{{#position}} line:{{position.line}}%{{/position}}` style usage, with
PER-FIELD sections ({{#position.line}}…{{/position.line}}) because
partial positions are the norm (presets write line+position+align, drag
writes line+position). vtt.cff appends its settings after the timestamp
line. SerializedCaption grows `position` in Phase 8 so {{json}} stays
lossless (class DEFINITIONS remain project-level: reachable only via
{{#classes}} — a stated boundary of {{json}}).

## The .cff grammar (the riskiest agnosticism surface — grown deliberately)

The interpreter today is flat token substitution. Phase 7 upgrades it
ONCE, establishing the pattern position reuses:

1. **Presence/truthiness sections**: `{{#field}}…{{/field}}` emits its
   content only when the field is present (booleans: true). Works in
   template bodies AND inside mapping open/close strings (applyValue
   grows beyond bare {{value}}). This one mechanism covers optional class
   properties, boolean class properties, per-field position emission, and
   "emit only when classes exist" guards.
2. **A real block parser**: sections must nest one level inside {{each}}
   (per-cue position guards live there); {{#classes}} is top-level only.
   validateTemplate learns the nesting rules and rejects violations.
3. **`requires:` version header**: new-grammar .cff files declare the
   grammar level they need; Phase 7 apps refuse (with a clear error) any
   file requiring more than they support. Old apps ignore unknown header
   keys, so the gate is additive — but it MUST ship with the first
   grammar growth: probes confirmed a new-grammar file in an old app
   silently blanks tokens in headers and passes literals through in cue
   lines. Also fixed alongside: unknown tokens in global context switch
   from silent-blank to literal passthrough, and the EXPORT path (not
   just the Format Manager editor) validates templates.

Capability honesty is PER-FEATURE: the check compares what the captions
use (run styles / classes / position) against what the template maps or
references, replacing today's any-styles-mapping short-circuit. One
COMPOSED notice per export lists everything dropped ("SubRip has no
mapping for: cue position"), dismissals are remembered per
(format, feature), and bulk export returns the dropped-feature set.
Property-level loss within a mapped feature (a color-only SRT class
mapping dropping boldness) is ACCEPTED and documented — the honesty
guarantee is scoped to whole features.

Format Manager preview: SAMPLE_CAPTIONS gain one classed run and one
positioned cue, plus sample class definitions threaded into
previewTemplate/executeTemplate (ExecuteOptions grows classes + position
inputs) — a .cff author must SEE the new grammar work in the live preview.

## Extensibility honesty (scoping the "any format" claim)

The grammar extends to any MARKUP-SHAPED TEXT format. Named edges:
- ASS/SSA is authorable only degradedly today: single-line events need a
  custom line joiner ({{text}} with a configurable join string — future
  additive), ASS-specific escaping ({ } braces — future escape mode),
  and its stateful override tags don't match the open/close stack model
  (class+emphasis overlaps emit imperfect resets). Possible, imperfect,
  known.
- SCC/CEA-608 and EBU-STL are CATEGORICALLY out of reach of any text
  template (parity-coded byte pairs / binary blocks) — these would be app
  features, not .cff files. The docs/notices must not imply otherwise.

## Explicit NON-goals for "styling complete" (the edges)

- Karaoke / word-level timing spans (VTT timestamps, ASS \k)
- Ruby text, vertical writing modes (position vocabulary doesn't preclude
  them later)
- Animation/transitions, font embedding
- Arbitrary inline color spans — color is CLASS-mediated (swatch flow
  auto-creates a class)
- Voice/speaker tags (VTT <v>) — parked with SDH; classes cover speaker
  coloring meanwhile
- Per-cue background windows beyond class `background`
- Simultaneous differently-placed cues: single-active-cue remains the
  renderer contract until import lands
- Media/project-level DEFAULT position (the "apply to all in this clip"
  action covers the practical need; a default-position model field would
  also touch .cff emission — revisit with import)
- Imported-file styling fidelity — belongs to the import feature
- Once-if-nonempty header wrapper construct (TTML single-header) — future
  grammar addition when a real format needs it

## Build order ("styling complete" = these land)

Phase 7 — grammar + classes:
  presence-sections + block parser + `requires:` + passthrough fix +
  export-path validation; class model + lifecycle + load sanitization;
  commit-then-apply popover panel (+ color-input spike on both engines);
  text-edit survival remap; inline class management in the panel; derived
  project sheet (CSSOM-built, all StyledLines surfaces); per-feature
  dropped-notice redesign; VTT builtin STYLE emission + SRT
  color-via-class; SAMPLE_CAPTIONS + preview threading; STYLE_ORDER
  comment fix + cross-version reorder test.
Phase 8 — position:
  model + semantics pin + split/merge carry (+tests) + presets (10-cell)
  + apply-to-all + numeric fields + inline-style preview + row glyph +
  {{position.*}} sections + vtt.cff settings + SerializedCaption.position
  + worksheet/UX copy updates.
Phase 9 — drag-on-video (interaction spec written then) + polish
  (multi-class merge in the VTT emitter, optional) + ship-time docs.
Each phase: implement → verify → adversarial audit → smoke → commit.

## Decisions log

2026-07-07 (roadmap): (1) SRT + VTT concrete, extensible to any
markup-shaped text format via .cff only — no format syntax in app code
(export side; import conversions are app machinery). (2) Presets AND
drag both in scope. (3) Color class-mediated only; swatch auto-create is
first-class Phase 7 UX ("I love that middle path"). (4) Voice/speaker
parked with SDH.

2026-07-07 (post-panel): (5) Editor mechanism = commit-then-apply — the
session commits before a class is applied; class spans stay outside the
contenteditable contract; survival via prefix/suffix splice remap.
(6) Bulk position = "apply to all captions in this clip" on the preset
control. (7) Position semantics = center-anchor model, VTT bridges via
`position:X%,center`, derived {{position.left}} for edge-based formats.
(8) No fourth manager modal — inline class management, immediate
undoable project edits. (9) Capability honesty scoped to whole features;
property-level loss within a mapped feature is accepted and documented.
