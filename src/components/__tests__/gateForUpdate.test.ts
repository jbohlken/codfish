import { describe, it, expect, beforeEach, vi } from "vitest";

// Tauri APIs are globally mocked in test-setup.ts.
vi.mock("../Splash", () => ({ startDaemon: vi.fn() }));
vi.mock("../ErrorModal", () => ({ showError: vi.fn() }));
vi.mock("../../lib/recovery", () => ({ clearRecovery: vi.fn(async () => {}) }));
vi.mock("../../lib/project", () => ({
  saveCurrentProject: vi.fn(),
}));

const confirmMock = vi.fn();
vi.mock("../UnsavedChanges", () => ({
  confirmUnsavedChanges: (...args: any[]) => confirmMock(...args),
  unsavedChanges: { value: null },
}));

import { gateForUpdate } from "../UpdateNotice";
import { project, projectPath, isDirty } from "../../store/app";
import { saveCurrentProject } from "../../lib/project";
import type { CodProject } from "../../types/project";

function makeProject(): CodProject {
  return {
    version: 1,
    name: "test",
    transcriptionModel: "base",
    language: "",
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
  (saveCurrentProject as any).mockReset();
});

describe("gateForUpdate", () => {
  it("passes through with no project open", async () => {
    const ok = await gateForUpdate("engine");
    expect(ok).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("clean project: prompts, Close project closes and passes", async () => {
    project.value = makeProject();
    projectPath.value = "/tmp/foo.cod";
    confirmMock.mockResolvedValue("save"); // "save" result = user clicked the confirm button ("Close project")

    const ok = await gateForUpdate("engine");
    expect(ok).toBe(true);
    expect(confirmMock).toHaveBeenCalledOnce();
    // Message should mention "transcription engine"
    expect(confirmMock.mock.calls[0][0]).toContain("transcription engine");
    // Button label should be "Close project" for clean
    expect(confirmMock.mock.calls[0][1].confirmLabel).toBe("Close project");
    // Project closed
    expect(project.value).toBeNull();
    expect(projectPath.value).toBeNull();
    // saveCurrentProject NOT called for clean project
    expect(saveCurrentProject).not.toHaveBeenCalled();
  });

  it("cancel aborts and leaves project loaded", async () => {
    project.value = makeProject();
    isDirty.value = true;
    confirmMock.mockResolvedValue("cancel");

    const ok = await gateForUpdate("engine");
    expect(ok).toBe(false);
    expect(project.value).not.toBeNull();
    expect(isDirty.value).toBe(true);
    expect(saveCurrentProject).not.toHaveBeenCalled();
  });

  it("dirty project: Save & close saves, closes, passes", async () => {
    project.value = makeProject();
    isDirty.value = true;
    confirmMock.mockResolvedValue("save");
    (saveCurrentProject as any).mockResolvedValue(true);

    const ok = await gateForUpdate("app");
    expect(ok).toBe(true);
    expect(saveCurrentProject).toHaveBeenCalledOnce();
    // Message should mention "Codfish" for app updates
    expect(confirmMock.mock.calls[0][0]).toContain("Codfish");
    // Button label should be "Save & close" for dirty
    expect(confirmMock.mock.calls[0][1].confirmLabel).toBe("Save & close");
    expect(project.value).toBeNull();
  });

  it("dirty project: save failure blocks close", async () => {
    project.value = makeProject();
    isDirty.value = true;
    confirmMock.mockResolvedValue("save");
    (saveCurrentProject as any).mockResolvedValue(false);

    const ok = await gateForUpdate("engine");
    expect(ok).toBe(false);
    // Project must NOT be closed when save failed
    expect(project.value).not.toBeNull();
    expect(isDirty.value).toBe(true);
  });
});
