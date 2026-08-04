# Codfish 0.6.0 Stabilization Testing Plan

## Caption Editing

### Split (S)

- [X] **S1** Split a caption with playhead in the middle -- both halves get correct text and timing
- [X] **S2** Split a caption that has rawWords (unedited) -- text re-wraps via formatPhraseToCaptionLines
- [X] **S3a** Split a manually edited caption -- user's text is preserved (proportional split, no rawWords clobber)
- [X] **S3b** Split a manually added caption (created with A, never had rawWords) -- text splits proportionally
- [X] **S3c** Split, then edit one half, then split that half again -- edits still preserved
- [X] **S4a** Split with playhead outside the caption -- blocked (button disabled, S key no-op)
- [X] **S4b** Split with playhead just inside the boundary (snap would land on boundary) -- splitPoint rounded inward by 1 frame, no 0-duration halves
- [!] **S4c** Split a 1-frame caption -- blocked, button disabled with tooltip "Caption too short to split"
    -Tooltip shows the 1-frame version when seek bar is outside
- [!] **S5** Split a single-word caption -- blocked, button disabled with tooltip "Can't split a single-word caption"; S key no-op
    -Tooltip shows the single-word version when seek bar is outside
- [X] **S6a** Split, then undo -- original caption restored, selection lands on the split caption
- [X] **S6b** Edit Media A, switch to Media B, undo -- selection switches back to Media A so the undone change is visible
- [X] **S6c** Undo, then redo -- selection lands at the location where the redone op was performed

Weird case:

1. Split a caption near a boundary -- creates 1 frame caption
2. Extend out point of new 1 frame caption -- doesn't snap to next frame (moves outwards by like 2.5 frames, which becomes its minimum, can never be manually set to 1, might point to a larger time issue)

### Merge (M)

- [X] **M1** Merge two adjacent captions -- timing spans both (start = first.start, end = second.end), text combined
- [!] **M2** Merge two unedited captions with rawWords -- text re-wraps via formatPhraseToCaptionLines
   - Experiencing an issue where the end of the second caption is somehow picking up the first word of the one after THAT?
- [!] **M3a** Merge two manually added captions (no rawWords either side) -- lines concatenated with space
   - Are we running manual captions through any of the formatting pipeline?
- [!] **M3b** Merge an edited caption with an unedited one -- text concatenated (no rawWords clobber); merged block inherits edited=true
   - Are we running edited captions through any of the formatting pipeline?
- [!] **M3c** Merge two edited captions -- text concatenated; merged block inherits edited=true
   - Same question as the last two about manual/edited captions. What is the criteria for merged captions to be formatted?
- [?] **M4** Merge two captions with different speakers -- speaker field dropped on merged block
   - Not testable at the moment.
- [!] **M5** Merge on last caption -- blocked (button disabled with tooltip, M key is no-op)
- [X] **M6a** Merge, then undo -- both captions restored, selection lands on the location where the merge happened
- [X] **M6b** Edit Media A (merge), switch to Media B, undo -- selection switches back to Media A so the undone merge is visible
- [X] **M7** Split then merge an unedited caption -- returns to roughly the original (text re-wrapped from same rawWords, edited=false preserved)
- [X] **M8** Merge captions across a non-adjacent gap (with empty time between them) -- merged caption spans the gap (start = first.start, end = second.end, gap absorbed)

### Delete (Delete/Backspace)

- [X] **D1** Delete a middle caption -- selection moves to next
- [!] **D2** Delete the last caption in the list -- selection moves to previous
  -- Undo doesn't highlight the deleted last caption
- [X] **D3** Delete the only caption -- selection clears, empty state shown
- [!] **D4** Delete, then undo -- caption restored
  -- Undo doesn't highlight the deleted last caption

### Add (A)

- [X] **A1** Add caption in a gap between two captions -- inserted correctly, edit mode activates
- [X] **A2** Add when playhead is inside an existing caption -- blocked
- [X] **A3** Add at the very end past all captions -- creates caption with reasonable duration
- [X] **A4** Press Escape on a newly added empty caption -- deletes it
- [X] **A5** Type text and press Enter -- commits the caption

I think undo history can result in bringing back an added caption that has no content in it.

### Edit (E / double-click)

- [?] **E1** Double-click a caption -- enters edit mode
 --- Should we do the same for double clicking the caption in the timeline?
- [X] **E2** Press E on selected caption -- enters edit mode
- [X] **E3** Edit text and press Enter -- saves changes
- [X] **E4** Edit text and press Escape -- discards changes
- [X] **E5** Clear all text and press Enter -- deletes the caption
- [!] **E6** Multi-line edit with Shift+Enter -- preserves line breaks
 --- Scrollbar appears after 2 lines on the edit text field, can we flex with the content? the non-editing state already does this.

---

## Undo/Redo

- [X] **U1** Undo after split/merge/delete/add/edit -- each restores correctly
- [X] **U2** Redo after undo -- re-applies the operation
- [X] **U3** Multiple undos back to initial state -- canUndo becomes false
- [X] **U4** Undo, then make a new edit -- redo history truncated
- [X] **U5** Ctrl+Z / Ctrl+Y on Windows (Cmd+Z / Cmd+Shift+Z on Mac)
- [X] **U6** Edit menu shows correct labels ("Undo Split caption", "Redo Merge captions", etc.)
- [X] **U7** Undo/redo after timeline resize -- restores caption timing

---

## Timeline

### Playback

- [X] **T1** Play/pause with transport button
- [X] **T2** Click waveform to seek -- playhead jumps correctly
-- Was: "Doesn't work if playing". Fixed on the `mediabunny` branch (engine-default playback + scrub-during-play race fix); retest at next release.
- [X] **T3** Drag on waveform to scrub
-- Was: "Doesn't work if playing". Fixed with T2 -- scrubbing a playing timeline now stops playback immediately on both players.
- [X] **T4** Caption list auto-scrolls to playing caption during playback
- [X] **T5** Playhead auto-scrolls into view when zoomed in

### Caption Block Resize

- [X] **T6** Drag left handle -- adjusts start time, frame-snapped
- [X] **T7** Drag right handle -- adjusts end time, frame-snapped
- [X] **T8** Drag handle past neighbor -- clamped, no overlap
- [X] **T9** Snapping enabled -- handle snaps to neighbor edge and minGap boundary
- [X] **T10** Snapping disabled -- free drag, still frame-snapped
- [X] **T11** Resize indicator line appears during drag
- [X] **T12** Release handle -- undo history entry created ("Resize caption")

First and last captions don't need to abide by the minGap rules for beginning and end of media item.

### Zoom

- [?] **T13** Ctrl+scroll to zoom in/out
-- This is working, but I also wonder if we just do scroll instead of Ctrl+Scroll
- [X] **T14** +/- buttons zoom in/out
- [X] **T15** Zoom label click resets to fit
- [X] **T16** Zoom anchors around cursor (Ctrl+scroll) or playhead (buttons)

-Should we reset zoom when a new project is loaded?
-~~Sometimes the waveform still doesn't appear at certain zoom sizes (inconsistent) — PARKED.~~ RESOLVED: WaveSurfer was replaced by a viewport-sized sticky-canvas painter (repaint cost O(viewport) at any zoom; no 32767px canvas limit).

### Timecode

- [X] **T17** Click timecode to cycle: Time > SMPTE > Frames > Time
- [X] **T18** SMPTE shows DF semicolons when media has dropFrame enabled
- [X] **T19** Mode persists across sessions (localStorage)

---

## Media Formats

### Video (playback + transcription)

- [X] **MF1** mp4 (h.264, HEVC -- HEVC relies on OS decoder extension being present)
- [X] **MF2** mov (h.264, HEVC; ~~ProRes = waveform + captions only, no playback~~ ProRes PLAYS via the mediabunny engine as of the `mediabunny` branch)
- [X] **MF3** webm (VP9 + Opus)
- [ ] **MF4** mkv (h.264 + AAC) -- NEW on the `mediabunny` branch: imports and plays via the engine (WebView2's <video> still rejects the container; the engine owns it)

Dropped: avi -- unsupported by both WebView2 and mediabunny; import shows the skipped-items notice. (mkv was dropped here for WebView2 patchiness; the engine un-dropped it.)

### Audio (playback + transcription)

- [X] **MF6** mp3
- [X] **MF7** wav
- [X] **MF9** aac
- [X] **MF10** flac
- [X] **MF11** ogg
- [ ] **MF16** m4a -- NEW on the `mediabunny` branch: imports and plays via the engine (was dropped for MEDIA_ERR_SRC_NOT_SUPPORTED)

For each: waveform loads, playback works, transcription produces captions.

Dropped: aif/aiff, au -- niche; mp3/wav/aac/flac/ogg/m4a cover the lossy/lossless use cases. (m4a was dropped here for WebView2 rejection; the engine un-dropped it.)

### No Audio Stream

- [X] **MF12** Video file with no audio track -- timeline waveform row shows "No audio track" (no sidecar call, no error spam)
- [X] **MF13** Video with no audio -- transcription blocked at the UI layer
   - Generate button replaced with "This file has no audio track" in the empty state
   - Regenerate button disabled with tooltip "No audio track -- nothing to transcribe"
   - Error modal wrapping fixed (was breaking mid-word with `word-break: break-all`; now uses `overflow-wrap: anywhere`)
- [X] **MF14** Video with no audio -- playback still works (video plays, no sound)
- [X] **MF15** Video with no audio -- manually adding captions still works

---

## Framerate / VFR / Drop Frame

### Framerate Detection

- [X] **FR1** Media with standard framerate (24, 25, 30, 60) -- fps badge shows detected value
- [X] **FR2** Media with no detectable framerate (audio-only) -- fps badge shows profile default with asterisk
- [X] **FR3** Media at 29.97fps -- detected and displayed correctly
- [X] **FR4** Media at 23.976fps -- detected and displayed correctly

### Variable Frame Rate (VFR)

- [X] **FR5** VFR media -- fps badge shows "VFR" label
- [X] **FR6** VFR media -- tooltip warns about VFR (wording is now player-aware: on the engine, displayed frames are exact and only the step grid is approximate; on the compatibility player both may be imprecise)
- [X] **FR7** VFR media -- captions still generate and export correctly
   -~~Waveform/caption regions not lining up, including the seek bar (drift?)~~ CLOSED on the `mediabunny` branch: the drift was the peaks time-axis stretch (AAC's padded final decode frame reported as the duration); fixed with an axis invariant (bins/duration == binsPerSec) and verified against the `vfr-clicks-h264-aac.mp4` fixture (1 kHz clicks at half-second marks + burned-in clock; clicks align with ruler ticks at every zoom, both sides of the mid-file rate switch).


### Drop Frame

- [X] **FR8** 29.97fps media with DF enabled -- SMPTE timecode uses semicolons (;)
- [X] **FR9** 29.97fps media with DF disabled -- SMPTE timecode uses colons (:)
- [?] **FR10** 30fps media with DF enabled -- should fall back to NDF (colons)
   - Do you mean switching to 30fps media from say a 29.97fps clip with DF enabled to ensure the display changes? 30 doesn't have DF/NDF
- [X] **FR11** 24fps media -- DF not applicable, always NDF
- [?] **FR12** Toggle DF setting on media -- timecodes in timeline and caption list update
   - Caption list shouldn't because it uses different time display?
- [X] **FR13** Export with SMPTE tokens -- DF/NDF respects media setting
- [X] **FR14** Timeline SMPTE mode label shows "SMPTE DF" when drop frame is active

### Frame Snapping

- [X] **FR15** Split a caption -- split point is frame-snapped
- [X] **FR16** Add a caption -- start/end are frame-snapped
- [X] **FR17** Resize a caption handle -- snaps to frame boundaries
- [X] **FR18** Generated captions -- all start/end times are frame-aligned
- [X] **FR19** Frame snapping at 24fps, 29.97fps, 30fps -- verify precision

Tick mark rounding -- noticed with a 24fps media item that when zoomed in to see individual frame ticks in the timeline, there were two entires for 01:01, then skipped to 01:03 -- can we look at rounding of the tick mark labels across display type?

---

## Export

- [X] **EX1** Export as SRT -- valid file, timestamps with commas
- [X] **EX2** Export as WebVTT -- WEBVTT header, timestamps with dots
- [X] **EX3** Export as JSON -- valid JSON array with all fields
- [X] **EX4** Export as Plain Text -- space-joined text, no timestamps
- [X] **EX5** Export with custom .cff format
- [X] **EX6** Export with SMPTE tokens in a custom format
- [X] **EX7** Export format dropdown persists selection
- [X] **EX8** Export with multi-line captions -- line breaks preserved in SRT/VTT
- [X] **EX9** Export empty project (no captions) -- graceful handling (no crash, clear feedback)

---

## Validation

- [X] **V1** Captions exceeding maxCharsPerLine show warnings
- [X] **V2** Captions exceeding maxDuration show warnings
- [X] **V3** Overlapping captions show warnings
   - Editor paths (resize, add, split, merge, pipeline) all prevent overlap; verified via hand-edited .cod — validator surfaces the warning as expected
   - Known: timeline resize handles get weird when overlap is present. Parked until caption import lands (first realistic path for overlap to enter a project).
- [X] **V4** Warnings appear in both caption list badges and timeline block colors
- [X] **V5** Strict vs fuzzy warnings render differently
- [X] **V6** Validation updates live after resize/edit (not stale from previous state)
- [X] **V7** minGap warnings appear when captions are too close together
- [X] **V8** Caption with more lines than maxLines shows warning
- [X] **V9** Caption shorter than minDuration shows warning
- [X] **V10** Caption exceeding maxCps (reading speed) shows warning
- [X] **V11** Two-line caption with imbalanced lengths (>60% difference) shows warning (always fuzzy)
- [X] **V12** minGapEnabled=false suppresses gap_flicker warnings even when captions are close
- [X] **V4a** Hover warning badge shows tooltip listing all warnings for that caption (label + detail rows)
- [X] **V5a** Caption with both strict and fuzzy warnings shows both colors; tooltip lists all in priority order (strict first)
- [X] **V13** Export proceeds even when captions have warnings (advisory-not-blocking by design — no pre-export validation gate)

---

## Profiles

- [X] **P1** Switch profile -- captions re-validate against new rules
- [X] **P2** Profile with strict maxCharsPerLine -- warnings show as strict (red)
- [X] **P3** Profile with non-strict maxCharsPerLine -- warnings show as fuzzy (yellow)
- [X] **P4** Profile changes affect generated caption line-breaking
- [X] **P5** Create a new custom profile -- appears in profile selector
- [X] **P6** Duplicate a profile -- auto-named `(copy)`
- [?] **P7** Edit a custom profile -- warnings update live
   - Updates on save
- [X] **P8** Delete a custom profile -- current project falls back to "Codfish"
- [X] **P9** Cannot edit/delete built-in profiles (readonly UI)
- [X] **P10** Import `.cfp` profile file
- [X] **P11** Export `.cfp` profile file
- [X] **P12** Open `.cod` with profile hash mismatch -- warning modal shows, local version is used anyway (intentional)
- [X] **P13** Change profile settings while captions exist -- validation updates live, but caption line-wrapping does NOT re-flow (only pipeline re-wraps; existing captions keep their layout)
- [X] **P14** Profile selection is project-scoped -- new project reverts to default "Codfish" (by design; not sticky across sessions)

---

## Format Builder

- [X] **FB1** Create a new custom format -- appears in export dropdown
- [X] **FB2** Edit a custom format template -- preview updates live
- [X] **FB3** Delete a custom format -- removed from dropdown
- [X] **FB4** Cannot edit/delete built-in formats
- [X] **FB5** Import a .cff file
- [X] **FB6** Export a .cff file
- [X] **FB7** Token autocomplete works in template editor
   - Can we drop punctuation from ends of template warnings?

---

## Project Management

- [X] **PM1** New project -- clears state, prompts for unsaved changes if dirty
- [X] **PM2** Open project (.cod file) -- loads correctly, media paths resolve
- [X] **PM3** Save -- writes .cod file, clears dirty flag, clears recovery
- [X] **PM4** Save As -- writes to new path, title bar + recents update to new path, clears dirty
- [?] **PM5** Revert -- dirty project reloads from disk, undo history resets, dirty flag clears; disabled when clean
   - Should this clear recovery?
- [X] **PM6** Close project -- clears state, timeline resets, recovery cleared; prompts if dirty
- [X] **PM7** Re-link media -- dialog opens, path updates, fps re-probed, playback resumes
- [X] **PM8** Multiple media items in one project -- switching between them works
- [X] **PM9** Open Recent -- submenu populated, click opens with unsaved-check gate, missing file shows error + prunes list, Clear Recent empties submenu
- [X] **PM10** Recovery -- force-quit with dirty project, next launch shows recovery prompt, restore recovers project with dirty flag, discard clears recovery file
- [?] **PM11** File association -- double-click .cod in Explorer/Finder opens app (or raises existing instance) with project loaded
   - How should this work if there's a recovery file?
- [?] **PM12** Dirty state -- title bar asterisk when dirty, save clears it, next edit re-dirties, undo to initial state clears it
   - Initial state does not clear dirty state
- [X] **PM13** Format/profile compatibility on open -- missing format/profile falls back to default + shows warning; modified hash shows mismatch warning

Can we look at everything that touches/should touch active.json to make sure it's working correctly?

---

## Menus

- [X] **MN1** File > New / Open / Save / Save As -- all work
- [X] **MN2** Edit > Undo / Redo -- labels update, accelerators work
- [X] **MN3** View > Dark Mode -- toggles theme
   - Does this persist between sessions?
- [X] **MN4** Help > Submit Feedback -- opens bug report modal
- [X] **MN5** Help > About (Windows) / App menu > About (Mac) -- opens About modal
- [X] **MN6** About modal shows version, sidecar version, copyright, log file button, acknowledgement links open browser

Submit Feedback and About modals can overlay.

---

## Edge Cases

- [X] **EC1** Open a project with no media -- empty state shown
- [X] **EC2** Import media, generate captions, close without saving -- unsaved changes prompt
- [X] **EC3** Very long media (1hr+) -- timeline and export handle large timestamps
- [X] **EC4** Rapid split/merge/undo sequences -- no state corruption
- [X] **EC5** Window resize -- panels and timeline reflow correctly
- [X] **EC6** Keyboard shortcuts don't fire while editing caption text (S, M, A, Delete, E)
- [X] **EC7** Click empty space in caption list -- deselects caption
- [X] **EC8** Click empty space in timeline blocks row -- deselects caption
- [X] **EC9** Select a caption, then Escape -- deselects
- [X] **EC10** Waveform loading spinner shows, then transitions to rendered waveform
- [X] **EC11** Dark mode -- all panels, modals, and timeline render correctly

Dial in profiles -- date last edited?
---

## Mediabunny engine addendum (post-0.6.0, `mediabunny` branch)

The media engine changed under everything above: mediabunny (WebCodecs) is now
the DEFAULT player for every clip, with the `<video>` element demoted to a
compatibility fallback (HDR, undecodable codecs, unreadable files — an amber
"compatibility playback" badge names the reason and its limits). Probing,
waveform peaks, and thumbnails also run in-process; the sidecar's ffmpeg is
transcription + fallback insurance only. New matrix for the next full pass:

### Playback engine

- [ ] **MB1** mp4/webm/mp3/wav (everyday formats) play via the engine — playback, pause, seek, end-of-media restart on spacebar
- [ ] **MB2** ProRes .mov plays with picture AND sound; A/V sync by ear
- [ ] **MB3** mkv and m4a import via dialog AND drag-drop, and play
- [ ] **MB4** Scrub or frame-step a PLAYING timeline — everything stops immediately (no ghost audio)
- [ ] **MB5** Compatibility badge: force with localStorage `codfish:playerEngine = "element"` + reload — amber chip on every clip, tooltip explains; remove key to restore
- [ ] **MB6** Volume slider + mute (transport bar, right side) — affects both players identically; persists across restarts; dragging while muted unmutes

### Step/scrub audio (engine clips only)

- [ ] **MB7** Frame step (arrow keys / transport buttons) — one frame's worth of audio blips at the landed position
- [ ] **MB8** Bare waveform drag — silent; holding Ctrl (Cmd on Mac) during the drag — audible grains, live mid-gesture
- [ ] **MB9** Compatibility-player clips — no blips/grains (expected; badge tooltip says so)

### Filmstrip

- [ ] **MB10** Video clips show the thumbnail lane; toggle button in the timeline toolbar (disabled for audio-only clips)
- [ ] **MB11** Re-opening a clip paints the strip instantly (persistent cache); thumbnails stay sharp after a zoom
- [ ] **MB12** Playhead ball sits on the ruler whether the filmstrip is shown or hidden; line crosses both lanes

### Dev battery (regression harness, dev builds only)

- [ ] **MB13** `npm run battery:media` generates the fixture suite; Ctrl+Shift+B → "run all fixtures" → RESULTS.md reports engine smoke ALL PASS (clock, frames-advance, seek+play, seek+pause, restart), peaks sanity with no FLAT/AXIS flags, and probe parity

### Release notes to carry (when this ships)

- New playable formats: ProRes .mov, .mkv, .m4a
- Compatibility-playback badge for files the engine hands to the system player
- Reverting from this build to an older one leaves the older build unable to READ the waveform cache (it regenerates every launch; harmless)
