import { signal } from "@preact/signals";

/** App update channel. "beta" also receives GitHub prereleases; "stable"
 *  only receives promoted releases. Persisted app-level (like theme), never
 *  in the .cod. Opting out of beta does NOT roll back an installed beta —
 *  the client simply rejoins stable's flow and converges when a stable
 *  release reaches or exceeds the running version (see docs/release-engineering). */
export type UpdateChannel = "stable" | "beta";

const CHANNEL_KEY = "codfish:updateChannel";

function getInitialChannel(): UpdateChannel {
  try {
    return localStorage.getItem(CHANNEL_KEY) === "beta" ? "beta" : "stable";
  } catch {
    return "stable";
  }
}

export const updateChannel = signal<UpdateChannel>(getInitialChannel());

export function setUpdateChannel(channel: UpdateChannel): void {
  updateChannel.value = channel;
  try { localStorage.setItem(CHANNEL_KEY, channel); } catch { /* best-effort */ }
}

// ── Dismissal of the OS-blocked notice ──────────────────────────────────────
// A below-floor machine can't install an offered update; rather than nag with
// a permanent badge, let the user dismiss it. Keyed by version so a NEWER
// blocked release re-notifies (you might have upgraded your OS since).

const BLOCKED_DISMISSED_KEY = "codfish:blockedUpdateDismissed";

export function isBlockedUpdateDismissed(version: string): boolean {
  try { return localStorage.getItem(BLOCKED_DISMISSED_KEY) === version; } catch { return false; }
}

export function dismissBlockedUpdate(version: string): void {
  try { localStorage.setItem(BLOCKED_DISMISSED_KEY, version); } catch { /* best-effort */ }
}

// ── OS-version gate (pure) ──────────────────────────────────────────────────

/** Compare two dotted numeric version strings ("13.4.1" vs "13.4").
 *  Returns <0 / 0 / >0. Non-numeric or missing segments count as 0, so
 *  "13.4" and "13.4.0" are equal and "Unknown" sorts as 0.0.0 (below any
 *  real floor — see isOsSupported's guard). Not a semver comparator: OS
 *  versions carry no prerelease/build parts, so numeric segments suffice. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i] ?? "0", 10) || 0;
    const nb = parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

/** True if the running OS `current` satisfies the release's `required`
 *  floor. A missing/empty floor means "no requirement" → always supported.
 *  A `current` that can't be parsed to any real number (e.g. "Unknown")
 *  is treated as UNSUPPORTED when a floor exists — fail safe: never offer
 *  an update we can't prove the OS can run. */
export function isOsSupported(current: string, required: string | null | undefined): boolean {
  if (!required) return true;
  if (!/\d/.test(current)) return false;
  return compareVersions(current, required) >= 0;
}

// ── Rust-command shapes (mirror src-tauri/src/updater.rs) ────────────────────

export interface OsInfo {
  os: string;       // "macos" | "windows" | "linux"
  version: string;  // "13.4.1", "10.0.22631", or "Unknown"
}

export interface AppUpdateMeta {
  version: string;
  notes: string | null;
  // serde serializes Rust field names verbatim → snake_case here.
  minimum_system_version: string | null;
}
