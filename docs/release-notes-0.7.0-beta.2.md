# Codfish 0.7.0-beta.2 — beta.1 feedback fixes

Fixes for the four issues found dogfooding beta.1 on macOS, plus one deliberate behavior change to seeking. Beta-channel users only (About ▸ "Receive beta updates").

## Fixed

- **Playhead no longer hides behind the waveform** at fit zoom on macOS (#41). A WebKit stacking quirk let the sticky waveform lane paint over the playhead line.
- **Play after reaching the end via seek works again** (#42). Seeking to the very end while playing now lands in the proper "ended" state, so the next play restarts from the top instead of doing nothing.
- **Scrub/step audio on MP3s is no longer crackly** (#44). Audio grains are now built as one contiguous buffer instead of scheduled per decode chunk; MP3's small chunks made the seams audible where WAV's didn't.

## Changed

- **Any seek stops playback; play is always explicit** (#43). Clicking or scrubbing the waveform, clicking a caption (timeline or list), jumping to start/end, frame steps, and search navigation all stop playback and move the playhead — no surface auto-resumes anymore. Previously some surfaces kept playing, some resumed after release, and some stopped; now there is one rule. Typing a search query still doesn't stop playback — highlighting matches isn't seeking.

## Known notes

- macOS is now in active testing (these fixes came from it); the beta.1 notes' caveats otherwise still apply.
- Project files (`.cod`) remain untouched and interchangeable with 0.6.x.
