import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
// Tauri + dialog APIs are noops here; withUnsavedCheck doesn't touch them
// directly but the module's imports would explode without these stubs.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../../../components/ErrorModal", () => ({
  showError: vi.fn(),
}));

// Controllable mock for the modal result
const confirmMock = vi.fn();
vi.mock("../../../components/UnsavedChanges", () => ({
  confirmUnsavedChanges: (...args: any[]) => confirmMock(...args),
}));

// Controllable mock for recovery clear
const clearRecoveryMock = vi.fn(async () => {});
vi.mock("../../recovery", () => ({
  clearRecovery: () => clearRecoveryMock(),
}));

// We need to assert against the real signals, so import AFTER mocks.
import { withUnsavedCheck } from "../index";
import { project, projectPath, isDirty } from "../../../store/app";
import type { CodProject } from "../../../types/project";

function makeProject(): CodProject {
  return {
    version: 1,
    name: "test",
    profileId: "default",
    transcriptionModel: "base",
    language: "",
    exportFormatId: "SRT",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    media: [],
  };
}

beforeEach(() => {
  project.value = null;
  projectPath.value = null;
  isDirty.value = false;
  confirmMock.mockReset();
  clearRecoveryMock.mockClear();
});

describe("withUnsavedCheck", () => {
  it("runs action directly when no project is open", async () => {
    const action = vi.fn(async () => true);
    const result = await withUnsavedCheck(action);
    expect(result).toBe(true);
    expect(action).toHaveBeenCalledOnce();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("closes a clean project before running action (no prompt)", async () => {
    project.value = makeProject();
    projectPath.value = "/tmp/foo.cod";
    const action = vi.fn(async () => {
      // By the time action runs, the old project must be closed.
      expect(project.value).toBeNull();
      expect(projectPath.value).toBeNull();
      return true;
    });
    const result = await withUnsavedCheck(action);
    expect(result).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledOnce();
  });

  it("returns false without running action when user cancels", async () => {
    project.value = makeProject();
    isDirty.value = true;
    confirmMock.mockResolvedValue("cancel");
    const action = vi.fn(async () => true);
    const result = await withUnsavedCheck(action);
    expect(result).toBe(false);
    expect(action).not.toHaveBeenCalled();
    // Old project must still be loaded
    expect(project.value).not.toBeNull();
    expect(isDirty.value).toBe(true);
  });

  it("discards: closes project, clears recovery, runs action", async () => {
    project.value = makeProject();
    isDirty.value = true;
    confirmMock.mockResolvedValue("discard");
    const action = vi.fn(async () => {
      // Project must be closed before the action runs.
      expect(project.value).toBeNull();
      expect(isDirty.value).toBe(false);
      return true;
    });
    const result = await withUnsavedCheck(action);
    expect(result).toBe(true);
    expect(clearRecoveryMock).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });

  it("discard + cancelled action: project stays closed", async () => {
    // Simulates user picking Discard then cancelling the file dialog.
    project.value = makeProject();
    isDirty.value = true;
    confirmMock.mockResolvedValue("discard");
    const action = vi.fn(async () => false);
    const result = await withUnsavedCheck(action);
    expect(result).toBe(false);
    expect(project.value).toBeNull();
    expect(isDirty.value).toBe(false);
  });

  it("saveCurrentProject clears recovery on successful write", async () => {
    project.value = makeProject();
    projectPath.value = "/tmp/foo.cod";
    isDirty.value = true;
    const { saveCurrentProject: save } = await import("../index");
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as any).mockResolvedValue(undefined);

    const ok = await save();
    expect(ok).toBe(true);
    expect(isDirty.value).toBe(false);
    expect(clearRecoveryMock).toHaveBeenCalled();
  });

  it("save path: saveCurrentProject failure short-circuits", async () => {
    // No projectPath means saveCurrentProject falls back to saveAs, which
    // calls the dialog save mock that returns undefined → save returns false.
    project.value = makeProject();
    projectPath.value = null;
    isDirty.value = true;
    confirmMock.mockResolvedValue("save");

    // Force saveCurrentProject to fail by mocking the dialog save to return null
    const { save: dialogSave } = await import("@tauri-apps/plugin-dialog");
    (dialogSave as any).mockResolvedValue(null);

    const action = vi.fn(async () => true);
    const result = await withUnsavedCheck(action);
    expect(result).toBe(false);
    expect(action).not.toHaveBeenCalled();
    // Old project still loaded since save failed
    expect(project.value).not.toBeNull();
  });
});
