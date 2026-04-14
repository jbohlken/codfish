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

- [ ] **E1** Double-click a caption -- enters edit mode
- [ ] **E2** Press E on selected caption -- enters edit mode
- [ ] **E3** Edit text and press Enter -- saves changes
- [ ] **E4** Edit text and press Escape -- discards changes
- [ ] **E5** Clear all text and press Enter -- deletes the caption
- [ ] **E6** Multi-line edit with Shift+Enter -- preserves line breaks

---

## Undo/Redo

- [ ] **U1** Undo after split/merge/delete/add/edit -- each restores correctly
- [ ] **U2** Redo after undo -- re-applies the operation
- [ ] **U3** Multiple undos back to initial state -- canUndo becomes false
- [ ] **U4** Undo, then make a new edit -- redo history truncated
- [ ] **U5** Ctrl+Z / Ctrl+Y on Windows (Cmd+Z / Cmd+Shift+Z on Mac)
- [ ] **U6** Edit menu shows correct labels ("Undo Split caption", "Redo Merge captions", etc.)
- [ ] **U7** Undo/redo after timeline resize -- restores caption timing

---

## Timeline

### Playback

- [ ] **T1** Play/pause with transport button
- [ ] **T2** Click waveform to seek -- playhead jumps correctly
- [ ] **T3** Drag on waveform to scrub
- [ ] **T4** Caption list auto-scrolls to playing caption during playback
- [ ] **T5** Playhead auto-scrolls into view when zoomed in

### Caption Block Resize

- [ ] **T6** Drag left handle -- adjusts start time, frame-snapped
- [ ] **T7** Drag right handle -- adjusts end time, frame-snapped
- [ ] **T8** Drag handle past neighbor -- clamped, no overlap
- [ ] **T9** Snapping enabled -- handle snaps to neighbor edge and minGap boundary
- [ ] **T10** Snapping disabled -- free drag, still frame-snapped
- [ ] **T11** Resize indicator line appears during drag
- [ ] **T12** Release handle -- undo history entry created ("Resize caption")

### Zoom

- [ ] **T13** Ctrl+scroll to zoom in/out
- [ ] **T14** +/- buttons zoom in/out
- [ ] **T15** Zoom label click resets to fit
- [ ] **T16** Zoom anchors around cursor (Ctrl+scroll) or playhead (buttons)

### Timecode

- [ ] **T17** Click timecode to cycle: Time > SMPTE > Frames > Time
- [ ] **T18** SMPTE shows DF semicolons when media has dropFrame enabled
- [ ] **T19** Mode persists across sessions (localStorage)

---

## Media Formats

### Video (playback + transcription)

- [ ] **MF1** mp4
- [ ] **MF2** mov
- [ ] **MF3** webm
- [ ] **MF4** mkv (may not play in webview -- transcription should still work)
- [ ] **MF5** avi (may not play in webview -- transcription should still work)

### Audio (playback + transcription)

- [ ] **MF6** mp3
- [ ] **MF7** wav
- [ ] **MF8** m4a
- [ ] **MF9** aac
- [ ] **MF10** flac
- [ ] **MF11** ogg

For each: waveform loads, playback works, transcription produces captions.

### No Audio Stream

- [ ] **MF12** Video file with no audio track -- waveform shows empty/loading state gracefully
- [ ] **MF13** Video with no audio -- transcription fails with a clear error message (not a crash)
- [ ] **MF14** Video with no audio -- playback still works (video plays, no sound)
- [ ] **MF15** Video with no audio -- manually adding captions still works

---

## Framerate / VFR / Drop Frame

### Framerate Detection

- [ ] **FR1** Media with standard framerate (24, 25, 30, 60) -- fps badge shows detected value
- [ ] **FR2** Media with no detectable framerate (audio-only) -- fps badge shows profile default with asterisk
- [ ] **FR3** Media at 29.97fps -- detected and displayed correctly
- [ ] **FR4** Media at 23.976fps -- detected and displayed correctly

### Variable Frame Rate (VFR)

- [ ] **FR5** VFR media -- fps badge shows "VFR" label
- [ ] **FR6** VFR media -- tooltip warns that frame-snapping may be imprecise
- [ ] **FR7** VFR media -- captions still generate and export correctly

### Drop Frame

- [ ] **FR8** 29.97fps media with DF enabled -- SMPTE timecode uses semicolons (;)
- [ ] **FR9** 29.97fps media with DF disabled -- SMPTE timecode uses colons (:)
- [ ] **FR10** 30fps media with DF enabled -- should fall back to NDF (colons)
- [ ] **FR11** 24fps media -- DF not applicable, always NDF
- [ ] **FR12** Toggle DF setting on media -- timecodes in timeline and caption list update
- [ ] **FR13** Export with SMPTE tokens -- DF/NDF respects media setting
- [ ] **FR14** Timeline SMPTE mode label shows "SMPTE DF" when drop frame is active

### Frame Snapping

- [ ] **FR15** Split a caption -- split point is frame-snapped
- [ ] **FR16** Add a caption -- start/end are frame-snapped
- [ ] **FR17** Resize a caption handle -- snaps to frame boundaries
- [ ] **FR18** Generated captions -- all start/end times are frame-aligned
- [ ] **FR19** Frame snapping at 24fps, 29.97fps, 30fps -- verify precision

---

## Export

- [ ] **EX1** Export as SRT -- valid file, timestamps with commas
- [ ] **EX2** Export as WebVTT -- WEBVTT header, timestamps with dots
- [ ] **EX3** Export as JSON -- valid JSON array with all fields
- [ ] **EX4** Export as Plain Text -- space-joined text, no timestamps
- [ ] **EX5** Export with custom .cff format
- [ ] **EX6** Export with SMPTE tokens in a custom format
- [ ] **EX7** Export format dropdown persists selection
- [ ] **EX8** Export with multi-line captions -- line breaks preserved in SRT/VTT
- [ ] **EX9** Export empty project (no captions) -- graceful handling (no crash, clear feedback)

---

## Validation

- [ ] **V1** Captions exceeding maxCharsPerLine show warnings
- [ ] **V2** Captions exceeding maxDuration show warnings
- [ ] **V3** Overlapping captions show warnings (after manual resize)
- [ ] **V4** Warnings appear in both caption list badges and timeline block colors
- [ ] **V5** Strict vs fuzzy warnings render differently
- [ ] **V6** Validation updates live after resize/edit (not stale from previous state)
- [ ] **V7** minGap warnings appear when captions are too close together

---

## Profiles

- [ ] **P1** Switch profile -- captions re-validate against new rules
- [ ] **P2** Profile with strict maxCharsPerLine -- warnings show as strict (red)
- [ ] **P3** Profile with non-strict maxCharsPerLine -- warnings show as fuzzy (yellow)
- [ ] **P4** Profile changes affect generated caption line-breaking

---

## Format Builder

- [ ] **FB1** Create a new custom format -- appears in export dropdown
- [ ] **FB2** Edit a custom format template -- preview updates live
- [ ] **FB3** Delete a custom format -- removed from dropdown
- [ ] **FB4** Cannot edit/delete built-in formats
- [ ] **FB5** Import a .cff file
- [ ] **FB6** Export a .cff file
- [ ] **FB7** Token autocomplete works in template editor

---

## Project Management

- [ ] **PM1** New project -- clears state, prompts for unsaved changes if dirty
- [ ] **PM2** Open project (.cod file) -- loads correctly, media re-links
- [ ] **PM3** Save / Save As -- writes .cod file, clears dirty flag
- [ ] **PM4** Re-link media -- dialog opens, path updates, playback resumes
- [ ] **PM5** Multiple media items in one project -- switching between them works

---

## Menus

- [ ] **MN1** File > New / Open / Save / Save As -- all work
- [ ] **MN2** Edit > Undo / Redo -- labels update, accelerators work
- [ ] **MN3** View > Dark Mode -- toggles theme
- [ ] **MN4** Help > Submit Feedback -- opens bug report modal
- [ ] **MN5** Help > About (Windows) / App menu > About (Mac) -- opens About modal
- [ ] **MN6** About modal shows version, sidecar version, copyright, log file button, acknowledgement links open browser

---

## Edge Cases

- [ ] **EC1** Open a project with no media -- empty state shown
- [ ] **EC2** Import media, generate captions, close without saving -- unsaved changes prompt
- [ ] **EC3** Very long media (1hr+) -- timeline and export handle large timestamps
- [ ] **EC4** Rapid split/merge/undo sequences -- no state corruption
- [ ] **EC5** Window resize -- panels and timeline reflow correctly
- [ ] **EC6** Keyboard shortcuts don't fire while editing caption text (S, M, A, Delete, E)
- [ ] **EC7** Click empty space in caption list -- deselects caption
- [ ] **EC8** Click empty space in timeline blocks row -- deselects caption
- [ ] **EC9** Select a caption, then Escape -- deselects
- [ ] **EC10** Waveform loading spinner shows, then transitions to rendered waveform
- [ ] **EC11** Dark mode -- all panels, modals, and timeline render correctly
