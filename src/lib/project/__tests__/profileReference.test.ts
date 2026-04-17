import { describe, it, expect, beforeEach, vi } from "vitest";

const showErrorMock = vi.fn();
vi.mock("../../../components/ErrorModal", () => ({ showError: (...args: any[]) => showErrorMock(...args) }));
vi.mock("../../../components/UnsavedChanges", () => ({ confirmUnsavedChanges: vi.fn() }));
vi.mock("../../recovery", () => ({ clearRecovery: vi.fn(async () => {}) }));
vi.mock("../../recent", () => ({ addRecent: vi.fn(async () => {}), loadRecent: vi.fn(async () => {}) }));
vi.mock("../../export", () => ({
  listFormats: vi.fn(async () => []),
  loadFormatSource: vi.fn(async () => ""),
}));

const loadProfilesMock = vi.fn();
const loadProfileSourceMock = vi.fn();
vi.mock("../../profiles", () => ({
  loadProfiles: (...args: any[]) => loadProfilesMock(...args),
  loadProfileSource: (...args: any[]) => loadProfileSourceMock(...args),
}));

const hashContentMock = vi.fn();
vi.mock("../../hash", () => ({
  hashContent: (...args: any[]) => hashContentMock(...args),
}));

// Import after mocks are set up
const { checkProfileCompatibility } = await import("../index");
import { selectedProfile } from "../../../store/app";
import type { CodProject } from "../../../types/project";

function makeProject(overrides?: Partial<CodProject>): CodProject {
  return {
    version: 1,
    name: "test",
    transcriptionModel: "base",
    language: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    media: [],
    ...overrides,
  };
}

const defaultProfile = { id: "default", name: "Codfish", description: "", builtIn: true, timing: {}, formatting: {}, merge: {} };
const netflixProfile = { id: "netflix", name: "Netflix", description: "", builtIn: true, timing: {}, formatting: {}, merge: {} };

describe("checkProfileCompatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectedProfile.value = "Codfish";
  });

  it("defaults selection to Default when project has no profileName", async () => {
    loadProfilesMock.mockResolvedValue([defaultProfile, netflixProfile]);

    await checkProfileCompatibility(makeProject());

    expect(selectedProfile.value).toBe("Codfish");
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("defaults to first available profile when Default is not installed", async () => {
    loadProfilesMock.mockResolvedValue([netflixProfile]);

    await checkProfileCompatibility(makeProject());

    expect(selectedProfile.value).toBe("Netflix");
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("shows error and falls back when profile is not installed", async () => {
    loadProfilesMock.mockResolvedValue([defaultProfile]);

    await checkProfileCompatibility(makeProject({
      profileName: "Custom Profile",
      profileHash: "abc123",
    }));

    expect(selectedProfile.value).toBe("Codfish");
    expect(showErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Custom Profile"),
    );
    expect(showErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("isn't installed"),
    );
  });

  it("selects profile and shows error when hash differs", async () => {
    loadProfilesMock.mockResolvedValue([defaultProfile]);
    loadProfileSourceMock.mockResolvedValue("[formatting]\nmaxCharsPerLine = 42");
    hashContentMock.mockResolvedValue("different_hash");

    await checkProfileCompatibility(makeProject({
      profileName: "Codfish",
      profileHash: "original_hash",
    }));

    expect(selectedProfile.value).toBe("Codfish");
    expect(showErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("differs"),
    );
  });

  it("selects profile silently when hash matches", async () => {
    loadProfilesMock.mockResolvedValue([netflixProfile]);
    loadProfileSourceMock.mockResolvedValue("[formatting]\nmaxCharsPerLine = 42");
    hashContentMock.mockResolvedValue("matching_hash");

    await checkProfileCompatibility(makeProject({
      profileName: "Netflix",
      profileHash: "matching_hash",
    }));

    expect(selectedProfile.value).toBe("Netflix");
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("selects profile and skips hash check when project has no profileHash", async () => {
    loadProfilesMock.mockResolvedValue([defaultProfile]);

    await checkProfileCompatibility(makeProject({
      profileName: "Codfish",
    }));

    expect(selectedProfile.value).toBe("Codfish");
    expect(loadProfileSourceMock).not.toHaveBeenCalled();
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("does not throw when loadProfiles fails", async () => {
    loadProfilesMock.mockRejectedValue(new Error("disk error"));

    await expect(
      checkProfileCompatibility(makeProject({
        profileName: "Codfish",
        profileHash: "abc",
      })),
    ).resolves.toBeUndefined();

    expect(showErrorMock).not.toHaveBeenCalled();
  });
});
