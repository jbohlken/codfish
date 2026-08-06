# Codfish 0.7.0-beta.3 — Bluetooth sync, Mac fixes, and a fish

Fixes from continued macOS dogfooding of the 0.7.0 line, plus one new face in the timeline. Beta-channel users only (About ▸ "Receive beta updates").

## New

- **The Cod-o-meter** 🐟 A reading-speed fish for the timeline, off by default (toggle in the timeline toolbar). The fish is a virtual reader pacing your media at the profile's max reading speed: swimming on the playhead means captions read exactly on pace, hovering behind it means viewers are still catching up, parked ahead means the current caption reads light. It swims at the current caption's speed — and goes belly-up when a caption exceeds the limit.

## Fixed

- **Audio/video sync on wireless audio** (AirPods, Bluetooth speakers). The engine now compensates for the output device's latency — video frames, the playhead, and pause positions track what you actually hear. The compensation follows device switches mid-session.
- **Playhead no longer hides behind the waveform** at fit zoom on macOS (#41, second attempt — the beta.2 fix addressed stacking order, but WebKit was deciding this at the compositing-layer level).
- **Scrubbing no longer highlights the timeline** on macOS (fallout of the playhead fix: an always-present-but-invisible text selection became visible; the timeline is no longer selectable text).
- **Finder drag-and-drop lands where you point** on macOS. Drop positions arrived measured from the window's title bar rather than the content area (and on Retina, doubly scaled); the drop target now calibrates against real clicks, so the highlighted bin is the bin that imports.
- **MP3 scrub/step audio no longer loses its first moments** (#44). MP3's decoder needs warm-up after a seek — cold decodes yielded silence for the first frames, VBR files for half a second or more. Every audio fetch now pre-rolls the decoder and discards the warm-up, which also fixes a brief audio hole after seeking in VBR MP3s during normal playback.
- **Frame-step blips are frame-length again** (1/fps, the Premiere model) for every format. Audio-only files (MP3 etc.) blip at the captioning profile's frame rate, so a video and its own audio extraction sound identical on the same profile.

## Known notes

- The beta.2 notes' caveats otherwise still apply. Project files (`.cod`) remain untouched and interchangeable with 0.6.x.
