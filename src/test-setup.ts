/**
 * Global Vitest setup — auto-mocks all @tauri-apps/* packages so any test
 * can transitively import Tauri-touching modules without crashing.
 *
 * Tests that need to assert against specific invoke calls can still
 * override these with vi.mock() locally — local mocks take precedence.
 */
import { vi } from "vitest";

// ── @tauri-apps/api ─────────────────────────────────────────────────────────

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
}));

vi.mock("@tauri-apps/api/window", () => {
  const win = {
    onCloseRequested: vi.fn(async () => vi.fn()),
    setTitle: vi.fn(async () => {}),
  };
  return { getCurrentWindow: vi.fn(() => win) };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()), // returns unlisten fn
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "0.0.0-test"),
}));

// ── Tauri plugins ───────────────────────────────────────────────────────────

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => {}),
  revealItemInDir: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(async () => {}),
}));
