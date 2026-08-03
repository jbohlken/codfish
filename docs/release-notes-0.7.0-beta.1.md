# Codfish 0.7.0-beta.1 — the media engine release

First beta of the 0.7.0 line. This beta replaces the media engine under the
editor; caption styling joins in a later beta. Beta-channel users only
(About ▸ "Receive beta updates").

## New

- **More formats play**: Apple ProRes `.mov` (previously silent black frame),
  `.mkv`, and `.m4a` now import and play. AVI remains unsupported.
- **Frame-step audio**: stepping with the arrow keys or transport buttons
  plays that frame's audio — spot word boundaries by ear.
- **Audible scrubbing**: hold **Ctrl** (Cmd on Mac) while dragging the
  waveform to hear the audio under the playhead, tape-style.
- **Volume control**: mute toggle + slider in the transport bar; one setting
  for everything, remembered across sessions.
- **Filmstrip**: a thumbnail lane above the waveform for video clips
  (toggleable in the timeline toolbar); strips reappear instantly on
  re-opened clips.
- **Exact timings**: durations and frame rates now come from the file's
  actual packets — VBR MP3s no longer over-report length, cloud-synced MP4s
  no longer show endless durations, imports no longer wait on the
  transcription engine, and VFR files get an honest badge.

## Changed

- Playback runs on a new built-in engine (WebCodecs) for every clip. Files
  the engine can't handle (HDR, unusual codecs) fall back to the system
  player and show an amber **"compatibility playback"** badge explaining
  what's different there. Everything else — timeline, captions,
  transcription, export, project files — behaves exactly as before.
- Project files (`.cod`) are untouched: anything saved in this beta opens in
  0.6.x and vice versa.

## Known notes

- **macOS is untested in this beta** (the macOS floor for the 0.7.0 line is
  13.4). Windows is the tested platform.
- If you return to a 0.6.x build after running this beta, waveforms
  regenerate on each clip open instead of caching (harmless; caching resumes
  on 0.7.x).
- Scrub/step audio applies to engine-played clips; compatibility-playback
  clips don't have it (the badge tooltip says so).
