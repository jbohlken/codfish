// Feature flags for parked / not-yet-exposed functionality.

// Language selection is currently hidden. The app is tailored for English, so we
// always auto-detect: the title-bar Language picker is gated off and generation
// ignores any `language` saved on a project (older projects auto-detect too).
// The picker code and the per-project `language` field are intentionally retained
// so this can be flipped back to true later without rebuilding any of it.
export const LANGUAGE_SELECTION_ENABLED: boolean = false;
