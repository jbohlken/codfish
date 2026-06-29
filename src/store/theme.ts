import { signal, computed, effect } from "@preact/signals";

// The user's explicit choice. "auto" follows the OS color scheme (and tracks it
// live); "light"/"dark" pin it. Persisted; defaults to "auto" for new installs.
export type ThemeMode = "auto" | "light" | "dark";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "codfish-theme";

function getInitialMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "auto" || saved === "light" || saved === "dark") return saved;
  return "auto";
}

// Track the OS color scheme so "auto" updates live if the user flips it mid-session.
// Guarded for non-DOM / stubbed test environments; defaults to dark when unknown
// (the app leans dark — the timeline stays dark regardless of theme).
const mq = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : null;
const systemDark = signal(mq?.matches ?? true);
mq?.addEventListener?.("change", (e) => { systemDark.value = e.matches; });

export const themeMode = signal<ThemeMode>(getInitialMode());

/** The light/dark actually applied to the document. */
export const resolvedTheme = computed<ResolvedTheme>(() =>
  themeMode.value === "auto" ? (systemDark.value ? "dark" : "light") : themeMode.value,
);

// Keep <html data-theme> in sync with the resolved theme — runs now (initial paint)
// and whenever the mode or the OS scheme changes. (:root is dark; [data-theme="light"]
// overrides, so setting either value is correct.)
effect(() => {
  document.documentElement.setAttribute("data-theme", resolvedTheme.value);
});

export function setThemeMode(mode: ThemeMode) {
  themeMode.value = mode;
  localStorage.setItem(STORAGE_KEY, mode);
}
