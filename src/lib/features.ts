// Feature flags for parked / not-yet-exposed functionality.

// Language selection is currently hidden. The app is tailored for English, so we
// always auto-detect: the title-bar Language picker is gated off and generation
// ignores any `language` saved on a project (older projects auto-detect too).
// The picker code and the per-project `language` field are intentionally retained
// so this can be flipped back to true later without rebuilding any of it.
export const LANGUAGE_SELECTION_ENABLED: boolean = false;

// Cod-o-meter (the reading-speed fish on the timeline playhead) is built and
// tested but parked for the 0.7.0 release. Gates both the timeline-toolbar
// toggle and the fish itself (a stale codfish:codometer localStorage value must
// not summon it while parked). Flip to true to ship it.
export const CODOMETER_ENABLED: boolean = false;
