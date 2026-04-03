import { signal } from "@preact/signals";

export type Theme = "dark" | "light";

const STORAGE_KEY = "codfish-theme";

function getInitialTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export const theme = signal<Theme>(getInitialTheme());

export function toggleTheme() {
  const next: Theme = theme.value === "dark" ? "light" : "dark";
  theme.value = next;
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(STORAGE_KEY, next);
}
