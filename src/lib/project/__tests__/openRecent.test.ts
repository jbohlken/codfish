import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: any[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const showErrorMock = vi.fn();
vi.mock("../../../components/ErrorModal", () => ({ showError: (...a: any[]) => showErrorMock(...a) }));

vi.mock("../../../components/UnsavedChanges", () => ({
  confirmUnsavedChanges: vi.fn(async () => "discard"),
}));

vi.mock("../../recovery", () => ({ clearRecovery: vi.fn(async () => {}) }));

const loadRecentMock = vi.fn(async () => {});
const addRecentMock = vi.fn(async (_path: string, _name: string) => {});
vi.mock("../../recent", () => ({
  loadRecent: () => loadRecentMock(),
  addRecent: (path: string, name: string) => addRecentMock(path, name),
}));

import { openRecent } from "../index";
import { project, projectPath, isDirty } from "../../../store/app";
import type { CodProject } from "../../../types/project";

function makeProject(): CodProject {
  return {
    version: 1,
    name: "current",
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
  invokeMock.mockReset();
  showErrorMock.mockReset();
  loadRecentMock.mockClear();
});

describe("openRecent", () => {
  it("missing file: refreshes recents, shows error, leaves current project untouched", async () => {
    const current = makeProject();
    project.value = current;
    projectPath.value = "/tmp/current.cod";

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "file_exists") return false;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const result = await openRecent("/tmp/missing.cod");
    expect(result).toBe(false);
    expect(loadRecentMock).toHaveBeenCalledOnce();
    expect(showErrorMock).toHaveBeenCalledOnce();
    // Current project must NOT have been closed.
    expect(project.value).toBe(current);
    expect(projectPath.value).toBe("/tmp/current.cod");
  });

  it("existing file: routes through unsaved-check and loads", async () => {
    const loaded: CodProject = { ...makeProject(), name: "loaded" };
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "file_exists") return true;
      if (cmd === "load_project") return JSON.stringify(loaded);
      return undefined;
    });

    const result = await openRecent("/tmp/ok.cod");
    expect(result).toBe(true);
    expect(showErrorMock).not.toHaveBeenCalled();
    expect(project.value?.name).toBe("loaded");
    expect(projectPath.value).toBe("/tmp/ok.cod");
  });
});
