# Codfish Roadmap

## 0.6.0 candidates

Features shortlisted for the next feature release. Current priority is bugfixes and stabilization.

- ~~**Format Builder v2** — refactor export format to tokenized `.cff` files that can be built and managed in-editor, including import/export~~
- **Stabilize editor** — ensure the bread-and-butter editing/timeline features are solid
- ~~**Merge captions** — combine adjacent captions (inverse of split)~~
- ~~**UI/UX cleanup** — streamline editor UI/UX and move items under the menu bar to ensure a clean, working interface~~
- ~~**Timing consistency** — ensure all time calculations are consistent throughout the entire captioning workflow, including timeline snapping, validation, export, SMPTE and drop-frame support where needed, VFR handling~~
- ~~**Audit undo/redo functionality** — make sure it's solid~~
  - ~~Decide redo accelerator per platform: `Ctrl+Y` vs `Ctrl+Shift+Z` on Windows (currently menu shows `Ctrl+Shift+Z` on both; `Ctrl+Y` works via keydown fallback)~~
  - ~~Decide whether the silent `Ctrl+Shift+Z` fallback on Windows should stay or be removed~~
- **Comprehensive test coverage** — make sure the app has reasonable and comprehensive test coverage (unit, component, integration)
- **Notarize apps** — get Windows and Mac apps signed
  - Mac ready for testing
  - Windows TBD

## 0.7.0 candidates

- **Caption styling** — preview, define, and export styling for captions, based on CSS under the hood; users should be able to load custom CSS rules to preview how they want for further flexibility. Must support currently offered export formats.
- **Editor themeing**
- **Standardize modals**

---

## Backlog

Potential features and changes to consider. Not prioritized.

## Distribution

- Download-on-first-run sidecar (plan exists, not yet built)
- GPU auto-detection to pick CPU vs CUDA sidecar
- macOS build/test pass
- Auto-updater via Tauri's built-in updater plugin

## Import / Export

- Import existing captions (SRT, VTT, ASS)
- Preview export output before saving
- Batch export all media in a project
- More default formats (ASS, TTML, SBV)
- Reset built-in export formats button (re-seed defaults)
- Subtitle burn-in (export video with hardcoded captions via ffmpeg)

## Transcription

- Cancel in-progress transcription (kill sidecar process)
- Speaker diarization (whisperx supports it, `speaker` field already on Word type)
- Batch transcription across multiple media items
- Real byte-level model download progress (currently faked with heartbeat)
- VAD / non-speech sounds toggle
- Multi-language workflow (translate captions, multiple language tracks per media)

## Caption Editing

- Merge adjacent captions (inverse of split)
- Multi-select captions for batch delete/retime
- Find and replace across all captions
- Spell check
- Keyboard navigation (arrow keys to move through caption list)
- Drag captions to reposition in timeline
- Shift-all-captions by a time offset
- Caption styling (italic, bold, positioning for SDH)
- Waveform-to-caption linking (click caption to jump to audio, click waveform to highlight text)

## Profiles

- "Open profiles folder" button (like export formats has)
- "Reset to defaults" for built-in profiles (delete and re-seed)
- Show profile description in the editor/selector
- Import/export profile files (share with team)

## Validation

- Auto-fix suggestions (e.g. "split this caption to fix line length")
- Shot change detection (detect scene cuts, ensure captions don't straddle them)
- Per-caption rule override (allow exceptions)
- Save with warnings modal (validate before save)

## Project

- Recent projects list on startup
- Auto-save on a timer or after N edits
- Crash recovery (temp file written periodically)
- Project-level notes/metadata
- File type associations (.cod files)

## Timeline

- Minimap for long media (zoomed-out overview strip)
- Bookmarks/markers at specific times
- Caption block color coding by validation status
- Handle knob visuals / hide handles during playback
- Caption timebase display following timeline timecode mode

## Misc

- Undo/redo for profile edits (currently not tracked)
- Persist window size/position across sessions
- Persist timecode mode and generation settings (localStorage or app config)
- Theming — light theme timeline (currently stays dark regardless)
- Batch processing (drop multiple files, generate captions unattended)
