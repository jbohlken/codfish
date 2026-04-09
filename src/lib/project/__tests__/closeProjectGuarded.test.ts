import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../../../components/ErrorModal", () => ({ showError: vi.fn() }));

const confirmMock = vi.fn();
vi.mock("../../../components/UnsavedChanges", () => ({
  confirmUnsavedChanges: (...args: any[]) => confirmMock(...args),
}));

const clearRecoveryMock = vi.fn(async () => {});
vi.mock("../../recovery", () => ({
  clearRecovery: () => clearRecoveryMock(),
}));

vi.mock("../../recent", () => ({
  addRecent: vi.fn(async () => {}),
  loadRecent: vi.fn(async () => {}),
}));

import { closeProjectGuarded } from "../index";
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

describe("closeProjectGuarded", () => {
  it("returns true immediately when no project is open", async () => {
    const result = await closeProjectGuarded();
    expect(result).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(clearRecoveryMock).not.toHaveBeenCalled();
  });

  it("clean project: clears recovery and closes without prompting", async () => {
    project.value = makeProject();
    projectPath.value = "/tmp/foo.cod";
    const result = await closeProjectGuarded();
    expect(result).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(clearRecoveryMock).toHaveBeenCalledOnce();
    expect(project.value).toBeNull();
    expect(projectPath.value).toBeNull();
  });

  it("dirty + cancel: leaves project intact", async () => {
    project.value = makeProject();
    isDirty.value = true;
    confirmMock.mockResolvedValue("cancel");
    const result = await closeProjectGuarded();
    expect(result).toBe(false);
    expect(project.value).not.toBeNull();
    expect(isDirty.value).toBe(true);
    expect(clearRecoveryMock).not.toHaveBeenCalled();
  });

  it("dirty + discard: clears recovery, closes project", async () => {
    project.value = makeProject();
    isDirty.value = true;
    confirmMock.mockResolvedValue("discard");
    const result = await closeProjectGuarded();
    expect(result).toBe(true);
    expect(clearRecoveryMock).toHaveBeenCalledOnce();
    expect(project.value).toBeNull();
    expect(isDirty.value).toBe(false);
  });

  it("dirty + save fails: leaves project intact", async () => {
    // No projectPath → saveCurrentProject falls back to saveAs, dialog returns null.
    project.value = makeProject();
    projectPath.value = null;
    isDirty.value = true;
    confirmMock.mockResolvedValue("save");
    const { save: dialogSave } = await import("@tauri-apps/plugin-dialog");
    (dialogSave as any).mockResolvedValue(null);

    const result = await closeProjectGuarded();
    expect(result).toBe(false);
    expect(project.value).not.toBeNull();
    expect(isDirty.value).toBe(true);
  });
});
