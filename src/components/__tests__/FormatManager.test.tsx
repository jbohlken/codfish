import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/preact";

// ── Module mocks (must be hoisted) ───────────────────────────────────────────

const saveFormatMock = vi.fn(async (filename: string, _content: string) => `/fake/${filename}`);
const deleteFormatMock = vi.fn(async (_filename: string) => {});
const loadFormatSourceMock = vi.fn(async (_path: string) => "");
const listFormatsMock = vi.fn(async () => [] as any[]);
const exportFormatFileMock = vi.fn(async (_path: string) => {});
const importFormatFileMock = vi.fn(async () => null as string | null);

vi.mock("../../lib/export", async () => {
  const actual = await vi.importActual<typeof import("../../lib/export")>("../../lib/export");
  return {
    ...actual,
    saveFormat: (...args: any[]) => (saveFormatMock as any)(...args),
    deleteFormat: (...args: any[]) => (deleteFormatMock as any)(...args),
    loadFormatSource: (...args: any[]) => (loadFormatSourceMock as any)(...args),
    listFormats: (...args: any[]) => (listFormatsMock as any)(...args),
    exportFormatFile: (...args: any[]) => (exportFormatFileMock as any)(...args),
    importFormatFile: (...args: any[]) => (importFormatFileMock as any)(...args),
  };
});

const showErrorMock = vi.fn();
vi.mock("../ErrorModal", () => ({
  showError: (...args: any[]) => (showErrorMock as any)(...args),
  ErrorModal: () => null,
}));

const confirmMock = vi.fn();
vi.mock("../UnsavedChanges", () => ({
  confirmUnsavedChanges: (...args: any[]) => (confirmMock as any)(...args),
  unsavedChanges: { value: null },
  UnsavedChanges: () => null,
}));

import { FormatManager, formatManagerOpen } from "../FormatManager";
import { exportFormats, selectedExportFormat } from "../../store/app";
import type { ExportFormat } from "../../lib/export";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeFormat(name: string, source: "builtin" | "custom" = "custom"): ExportFormat {
  return {
    id: name,
    name,
    extension: "txt",
    formatPath: `/fake/${name}.cff`,
    source,
  };
}

function cffSource(name: string, ext: string, template: string, isBuiltin = false): string {
  return `name: ${name}\next: ${ext}${isBuiltin ? "\nsource: builtin" : ""}\n\n${template}`;
}

const BASIC_TEMPLATE = "{{each}}{{text}}{{/each}}";
const DEFAULT_TEMPLATE = "{{each}}\n\n{{/each}}";

/**
 * Install a loadFormatSource implementation that reads from whatever is
 * currently in `exportFormats.value` — so mid-flow formats added via
 * listFormats are handled too.
 */
function installDynamicLoadSource() {
  loadFormatSourceMock.mockImplementation(async (path: string) => {
    const f = exportFormats.value.find((f) => f.formatPath === path);
    if (!f) return "";
    return cffSource(f.name, f.extension, BASIC_TEMPLATE, f.source === "builtin");
  });
}

/** Open the modal with the given formats, optionally clicking one by name. */
async function openWith(formats: ExportFormat[], activeName?: string) {
  exportFormats.value = formats;
  installDynamicLoadSource();
  formatManagerOpen.value = true;
  const result = render(<FormatManager />);
  if (activeName) {
    fireEvent.click(screen.getByText(activeName));
    await waitFor(() => expect(screen.getByDisplayValue(activeName)).toBeTruthy());
  }
  return result;
}

beforeEach(() => {
  cleanup();
  formatManagerOpen.value = false;
  exportFormats.value = [];
  selectedExportFormat.value = "";
  saveFormatMock.mockClear();
  deleteFormatMock.mockClear();
  loadFormatSourceMock.mockReset();
  listFormatsMock.mockReset();
  listFormatsMock.mockResolvedValue([]);
  exportFormatFileMock.mockClear();
  importFormatFileMock.mockReset();
  showErrorMock.mockClear();
  confirmMock.mockReset();
});

// ── Render + selection ──────────────────────────────────────────────────────

describe("FormatManager: render + selection", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<FormatManager />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the list of formats when open", async () => {
    await openWith([makeFormat("SRT", "builtin"), makeFormat("Custom")], "SRT");
    expect(screen.getByText("SRT")).toBeTruthy();
    expect(screen.getByText("Custom")).toBeTruthy();
  });

  it("opens with no format selected", async () => {
    const { container } = await openWith([makeFormat("Other"), makeFormat("Custom")]);
    expect(container.querySelector(".fmt-editor-empty")).toBeTruthy();
    expect(container.querySelector(".fmt-list-item--active")).toBeNull();
  });

  it("opens with empty editor when no format is clicked", async () => {
    exportFormats.value = [makeFormat("First"), makeFormat("Second")];
    installDynamicLoadSource();
    formatManagerOpen.value = true;
    const { container } = render(<FormatManager />);
    expect(container.querySelector(".fmt-editor-empty")).toBeTruthy();
  });

  it("shows empty editor when there are no formats", async () => {
    const { container } = await openWith([]);
    expect(container.querySelector(".fmt-editor-empty")).toBeTruthy();
  });

  it("renders a divider between builtins and custom", async () => {
    const { container } = await openWith(
      [makeFormat("SRT", "builtin"), makeFormat("Custom")],
      "SRT",
    );
    expect(container.querySelector(".fmt-list-divider")).toBeTruthy();
  });

  it("does not render a divider when only one source is present", async () => {
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    expect(container.querySelector(".fmt-list-divider")).toBeNull();
  });

  it("marks a format as active after clicking it", async () => {
    const { container } = await openWith(
      [makeFormat("One"), makeFormat("Two")],
    );
    fireEvent.click(screen.getByText("Two"));
    await waitFor(() => {
      const active = container.querySelectorAll(".fmt-list-item--active");
      expect(active).toHaveLength(1);
      expect(active[0].textContent).toContain("Two");
    });
  });

  it("surfaces a parse failure via showError and leaves editor empty", async () => {
    exportFormats.value = [makeFormat("Broken")];
    loadFormatSourceMock.mockResolvedValue("garbage without blank line");
    formatManagerOpen.value = true;
    render(<FormatManager />);
    fireEvent.click(screen.getByText("Broken"));
    await waitFor(() => expect(showErrorMock).toHaveBeenCalled());
    expect(showErrorMock.mock.calls[0][0]).toMatch(/cannot be opened/);
  });

  it("surfaces a load failure via showError", async () => {
    exportFormats.value = [makeFormat("BadIO")];
    loadFormatSourceMock.mockRejectedValue(new Error("ENOENT"));
    formatManagerOpen.value = true;
    render(<FormatManager />);
    fireEvent.click(screen.getByText("BadIO"));
    await waitFor(() => expect(showErrorMock).toHaveBeenCalled());
    expect(showErrorMock.mock.calls[0][0]).toMatch(/Failed to load/);
  });
});

// ── Readonly (builtin) state ────────────────────────────────────────────────

describe("FormatManager: readonly state", () => {
  it("shows the readonly banner for builtin formats", async () => {
    await openWith([makeFormat("SRT", "builtin")], "SRT");
    expect(screen.getByText(/Built-in format/)).toBeTruthy();
  });

  it("replaces Save with Duplicate for builtins", async () => {
    await openWith([makeFormat("SRT", "builtin")], "SRT");
    expect(screen.queryByText("Save")).toBeNull();
    expect(screen.getByText(/Duplicate/)).toBeTruthy();
  });

  it("disables all inputs for builtins", async () => {
    const { container } = await openWith([makeFormat("SRT", "builtin")], "SRT");
    const inputs = container.querySelectorAll(
      "input[disabled], textarea[disabled]",
    ) as NodeListOf<HTMLInputElement | HTMLTextAreaElement>;
    // Name, extension, template = 3 disabled fields
    expect(inputs.length).toBeGreaterThanOrEqual(3);
  });

  it("hides the token-suggestion hint for builtins", async () => {
    await openWith([makeFormat("SRT", "builtin")], "SRT");
    expect(screen.queryByText(/for token suggestions/)).toBeNull();
  });

  it("hides the delete button for builtins", async () => {
    const { container } = await openWith([makeFormat("SRT", "builtin")], "SRT");
    expect(container.querySelector('[data-tooltip="Delete format"]')).toBeNull();
  });

  it("does not compute inline errors for builtins", async () => {
    await openWith([makeFormat("SRT", "builtin")], "SRT");
    // Even though a builtin could in theory have missing fields, the component
    // skips validation for readonly.
    expect(screen.queryByText("Required")).toBeNull();
  });
});

// ── Dirty state + Save button ───────────────────────────────────────────────

describe("FormatManager: dirty tracking", () => {
  it("Save button is disabled when clean", async () => {
    await openWith([makeFormat("Custom")], "Custom");
    const btn = screen.getByText("Save").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Save button enables when dirty + valid", async () => {
    await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "Renamed" } });
    await waitFor(() => {
      const btn = screen.getByText("Save").closest("button") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
  });

  it("Save button stays disabled when dirty but invalid", async () => {
    await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "" } });
    await waitFor(() => {
      const btn = screen.getByText("Save").closest("button") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });
  });

  it("shows a dirty dot on the edited list item", async () => {
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    expect(container.querySelector(".fmt-list-item-dot")).toBeNull();
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "Edited" } });
    await waitFor(() => {
      expect(container.querySelector(".fmt-list-item-dot")).not.toBeNull();
    });
  });

  it("clears the dirty dot when edit is reverted to the saved value", async () => {
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    const input = screen.getByDisplayValue("Custom") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "Edited" } });
    await waitFor(() => expect(container.querySelector(".fmt-list-item-dot")).not.toBeNull());
    fireEvent.input(input, { target: { value: "Custom" } });
    await waitFor(() => expect(container.querySelector(".fmt-list-item-dot")).toBeNull());
  });

  it("treats editing the extension as dirty", async () => {
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    const extInput = screen.getByDisplayValue("txt") as HTMLInputElement;
    fireEvent.input(extInput, { target: { value: "srt" } });
    await waitFor(() =>
      expect(container.querySelector(".fmt-list-item-dot")).not.toBeNull(),
    );
  });

  it("treats editing the template as dirty", async () => {
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    const templateArea = container.querySelector(".fb-editor-textarea") as HTMLTextAreaElement;
    fireEvent.input(templateArea, { target: { value: "{{each}}new{{/each}}" } });
    await waitFor(() =>
      expect(container.querySelector(".fmt-list-item-dot")).not.toBeNull(),
    );
  });

  it("readonly builtins are never dirty, even if forced", async () => {
    const { container } = await openWith([makeFormat("SRT", "builtin")], "SRT");
    // Disabled inputs can't be edited in the UI; verify no dot + no Save button
    expect(container.querySelector(".fmt-list-item-dot")).toBeNull();
    expect(screen.queryByText("Save")).toBeNull();
  });
});

// ── Inline validation ────────────────────────────────────────────────────────

describe("FormatManager: inline validation", () => {
  it("shows Required under name when cleared", async () => {
    await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("Required")).toBeTruthy());
  });

  it("shows Required under extension when cleared", async () => {
    await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("txt"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("Required")).toBeTruthy());
  });

  it("shows Required under template when cleared", async () => {
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    const templateArea = container.querySelector(".fb-editor-textarea") as HTMLTextAreaElement;
    fireEvent.input(templateArea, { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("Required")).toBeTruthy());
  });

  it("shows three Required errors when all fields are empty", async () => {
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "" } });
    fireEvent.input(screen.getByDisplayValue("txt"), { target: { value: "" } });
    const templateArea = container.querySelector(".fb-editor-textarea") as HTMLTextAreaElement;
    fireEvent.input(templateArea, { target: { value: "" } });
    await waitFor(() => {
      expect(container.querySelectorAll(".fb-field-error").length).toBe(3);
    });
    const btn = screen.getByText("Save").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("shows 'Name in use' when renaming to an existing format", async () => {
    await openWith([makeFormat("Custom"), makeFormat("Other")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "Other" } });
    await waitFor(() => expect(screen.getByText("Name in use")).toBeTruthy());
  });

  it("clears inline errors when the field becomes valid again", async () => {
    await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("Required")).toBeTruthy());
    fireEvent.input(screen.getByDisplayValue(""), { target: { value: "Fixed" } });
    await waitFor(() => expect(screen.queryByText("Required")).toBeNull());
  });

  it("adds error class to the input when invalid", async () => {
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "" } });
    await waitFor(() => {
      expect(container.querySelector(".fb-input--error")).not.toBeNull();
    });
  });

  it("re-enables Save after an invalid field is refilled", async () => {
    await openWith([makeFormat("Custom")], "Custom");
    const input = screen.getByDisplayValue("Custom") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "" } });
    await waitFor(() => {
      const btn = screen.getByText("Save").closest("button") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });
    fireEvent.input(input, { target: { value: "Renamed" } });
    await waitFor(() => {
      const btn = screen.getByText("Save").closest("button") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
  });
});

// ── Close guard ─────────────────────────────────────────────────────────────

describe("FormatManager: close guard", () => {
  function clickClose(container: Element) {
    const closeBtn = container.querySelector(".fmt-manager-header button") as HTMLButtonElement;
    fireEvent.click(closeBtn);
  }

  it("closes immediately when clean", async () => {
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    clickClose(container);
    await waitFor(() => expect(formatManagerOpen.value).toBe(false));
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("prompts then closes when dirty + discard", async () => {
    confirmMock.mockResolvedValue("discard");
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "Dirty" } });
    clickClose(container);
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await waitFor(() => expect(formatManagerOpen.value).toBe(false));
  });

  it("stays open when dirty + cancel", async () => {
    confirmMock.mockResolvedValue("cancel");
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "Dirty" } });
    clickClose(container);
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(formatManagerOpen.value).toBe(true);
  });

  it("saves then closes when dirty + save + valid", async () => {
    confirmMock.mockResolvedValue("save");
    listFormatsMock.mockResolvedValue([makeFormat("Renamed")]);
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "Renamed" } });
    clickClose(container);
    await waitFor(() => expect(saveFormatMock).toHaveBeenCalled());
    await waitFor(() => expect(formatManagerOpen.value).toBe(false));
  });

  it("stays open when dirty + save but invalid", async () => {
    confirmMock.mockResolvedValue("save");
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "" } });
    clickClose(container);
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(saveFormatMock).not.toHaveBeenCalled();
    expect(formatManagerOpen.value).toBe(true);
  });
});

// ── List-switch guard ───────────────────────────────────────────────────────

describe("FormatManager: list-switch guard", () => {
  it("switches freely when clean", async () => {
    await openWith([makeFormat("Custom"), makeFormat("Other")], "Custom");
    fireEvent.click(screen.getByText("Other"));
    await waitFor(() => expect(screen.getByDisplayValue("Other")).toBeTruthy());
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("prompts on list-switch when dirty", async () => {
    confirmMock.mockResolvedValue("discard");
    await openWith([makeFormat("Custom"), makeFormat("Other")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "Dirty" } });
    fireEvent.click(screen.getByText("Other"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
  });

  it("does not prompt when clicking the already-selected item", async () => {
    await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "Dirty" } });
    fireEvent.click(screen.getByText("Custom"));
    // Give any pending promise a chance to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("cancel keeps the original format selected", async () => {
    confirmMock.mockResolvedValue("cancel");
    await openWith([makeFormat("Custom"), makeFormat("Other")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "Dirty" } });
    fireEvent.click(screen.getByText("Other"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    // Still on Custom, still dirty
    expect((screen.getByDisplayValue("Dirty") as HTMLInputElement).value).toBe("Dirty");
  });
});

// ── Save behavior ───────────────────────────────────────────────────────────

describe("FormatManager: save", () => {
  it("writes trimmed name on save and lands in clean state", async () => {
    listFormatsMock.mockResolvedValue([makeFormat("Trimmed")]);
    const { container } = await openWith([makeFormat("Custom")], "Custom");

    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "Trimmed  " } });
    const saveBtn = screen.getByText("Save").closest("button") as HTMLButtonElement;
    fireEvent.click(saveBtn);

    await waitFor(() => expect(saveFormatMock).toHaveBeenCalled());
    const [, content] = saveFormatMock.mock.calls[0] as [string, string];
    expect(content).toMatch(/^name: Trimmed\n/);
    expect(content).not.toMatch(/name: Trimmed  /);

    // After save completes, editor should be clean (no dot)
    await waitFor(() => expect(container.querySelector(".fmt-list-item-dot")).toBeNull());
  });

  it("trims extension too", async () => {
    listFormatsMock.mockResolvedValue([makeFormat("Custom")]);
    await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("txt"), { target: { value: " srt " } });
    fireEvent.click(screen.getByText("Save").closest("button") as HTMLButtonElement);
    await waitFor(() => expect(saveFormatMock).toHaveBeenCalled());
    const [, content] = saveFormatMock.mock.calls[0] as [string, string];
    expect(content).toContain("ext: srt");
    expect(content).not.toContain("ext:  srt");
  });

  it("preserves template whitespace verbatim", async () => {
    listFormatsMock.mockResolvedValue([makeFormat("Custom")]);
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    const templateArea = container.querySelector(".fb-editor-textarea") as HTMLTextAreaElement;
    const wonky = "  \n{{each}}\n  {{text}}\n{{/each}}\n  ";
    fireEvent.input(templateArea, { target: { value: wonky } });
    fireEvent.click(screen.getByText("Save").closest("button") as HTMLButtonElement);
    await waitFor(() => expect(saveFormatMock).toHaveBeenCalled());
    const [, content] = saveFormatMock.mock.calls[0] as [string, string];
    expect(content).toContain(wonky);
  });

  it("surfaces save failures inline", async () => {
    saveFormatMock.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByText("Save").closest("button") as HTMLButtonElement);
    await waitFor(() => {
      expect(container.querySelector(".fb-error")?.textContent).toMatch(/disk full/);
    });
    // Still dirty
    expect(container.querySelector(".fmt-list-item-dot")).not.toBeNull();
  });

  it("reuses the editingFilename on subsequent saves", async () => {
    listFormatsMock.mockResolvedValue([makeFormat("Custom")]);
    await openWith([makeFormat("Custom")], "Custom");
    // First edit + save
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "Custom " } });
    fireEvent.click(screen.getByText("Save").closest("button") as HTMLButtonElement);
    await waitFor(() => expect(saveFormatMock).toHaveBeenCalledTimes(1));
    const firstFilename = saveFormatMock.mock.calls[0][0];
    expect(firstFilename).toBe("Custom.cff"); // taken from fmt.formatPath basename

    // Second edit + save — same filename
    await waitFor(() => expect(screen.getByDisplayValue("Custom")).toBeTruthy());
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "Custom2" } });
    listFormatsMock.mockResolvedValue([makeFormat("Custom2")]);
    fireEvent.click(screen.getByText("Save").closest("button") as HTMLButtonElement);
    await waitFor(() => expect(saveFormatMock).toHaveBeenCalledTimes(2));
    expect(saveFormatMock.mock.calls[1][0]).toBe(firstFilename);
  });
});

// ── New-format flow ─────────────────────────────────────────────────────────

describe("FormatManager: new format", () => {
  it("creates a new format with default name and opens it in the editor", async () => {
    const { container } = await openWith([]);
    // After the click: listFormats returns the new format
    listFormatsMock.mockResolvedValue([makeFormat("New format")]);
    loadFormatSourceMock.mockImplementation(async (path: string) => {
      if (path === "/fake/New format.cff") {
        return cffSource("New format", "txt", DEFAULT_TEMPLATE);
      }
      return "";
    });

    fireEvent.click(screen.getByText("New"));

    await waitFor(() => expect(saveFormatMock).toHaveBeenCalled());
    const [, content] = saveFormatMock.mock.calls[0] as [string, string];
    expect(content).toMatch(/^name: New format\n/);
    expect(content).toContain("ext: txt");

    await waitFor(() => expect(screen.getByDisplayValue("New format")).toBeTruthy());
    // Clean (not dirty) after creation
    expect(container.querySelector(".fmt-list-item-dot")).toBeNull();
  });

  it("uniquifies the default name when 'New format' already exists", async () => {
    const existing = makeFormat("New format");
    await openWith([existing], "New format");
    listFormatsMock.mockResolvedValue([existing, makeFormat("New format 2")]);

    fireEvent.click(screen.getByText("New"));

    await waitFor(() => expect(saveFormatMock).toHaveBeenCalled());
    const [, content] = saveFormatMock.mock.calls[0] as [string, string];
    expect(content).toContain("name: New format 2");
  });

  it("uses a random .cff filename (not the display name)", async () => {
    await openWith([]);
    listFormatsMock.mockResolvedValue([makeFormat("New format")]);

    fireEvent.click(screen.getByText("New"));

    await waitFor(() => expect(saveFormatMock).toHaveBeenCalled());
    const filename = saveFormatMock.mock.calls[0][0];
    expect(filename).toMatch(/^user-[0-9a-f]{8}\.cff$/);
  });

  it("guards unsaved changes before creating a new format", async () => {
    confirmMock.mockResolvedValue("cancel");
    await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "Dirty" } });
    fireEvent.click(screen.getByText("New"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(saveFormatMock).not.toHaveBeenCalled();
  });

  it("surfaces New-flow failures via showError", async () => {
    saveFormatMock.mockImplementationOnce(async () => {
      throw new Error("write failed");
    });
    await openWith([]);
    fireEvent.click(screen.getByText("New"));
    await waitFor(() => expect(showErrorMock).toHaveBeenCalled());
    expect(String(showErrorMock.mock.calls[0][0])).toMatch(/write failed/);
  });
});

// ── Duplicate flow ──────────────────────────────────────────────────────────

describe("FormatManager: duplicate", () => {
  it("duplicates a builtin with '(copy)' suffix and switches to the new format", async () => {
    await openWith([makeFormat("SRT", "builtin")], "SRT");
    // After dup: listFormats returns both
    listFormatsMock.mockResolvedValue([
      makeFormat("SRT", "builtin"),
      makeFormat("SRT (copy)"),
    ]);

    fireEvent.click(screen.getByText(/Duplicate/));

    await waitFor(() => expect(saveFormatMock).toHaveBeenCalled());
    const [, content] = saveFormatMock.mock.calls[0] as [string, string];
    expect(content).toContain("name: SRT (copy)");
    expect(content).toContain("ext: txt");

    await waitFor(() => expect(screen.getByDisplayValue("SRT (copy)")).toBeTruthy());
  });

  it("uniquifies the copy suffix when one already exists", async () => {
    await openWith(
      [makeFormat("SRT", "builtin"), makeFormat("SRT (copy)")],
      "SRT",
    );
    listFormatsMock.mockResolvedValue([
      makeFormat("SRT", "builtin"),
      makeFormat("SRT (copy)"),
      makeFormat("SRT (copy) 2"),
    ]);

    fireEvent.click(screen.getByText(/Duplicate/));

    await waitFor(() => expect(saveFormatMock).toHaveBeenCalled());
    const [, content] = saveFormatMock.mock.calls[0] as [string, string];
    expect(content).toContain("name: SRT (copy) 2");
  });

  it("the duplicated format is writable (not readonly)", async () => {
    await openWith([makeFormat("SRT", "builtin")], "SRT");
    listFormatsMock.mockResolvedValue([
      makeFormat("SRT", "builtin"),
      makeFormat("SRT (copy)"),
    ]);
    fireEvent.click(screen.getByText(/Duplicate/));
    await waitFor(() => expect(screen.getByDisplayValue("SRT (copy)")).toBeTruthy());
    // No readonly banner
    expect(screen.queryByText(/Built-in format/)).toBeNull();
    // Save button exists (not Duplicate)
    expect(screen.getByText("Save")).toBeTruthy();
  });

  it("guards unsaved edits to a builtin's duplicate target before duplicating", async () => {
    // This is edge: user is on a builtin (never dirty), clicks Duplicate.
    // No guard is needed, but if the user had navigated from a dirty custom
    // format the list-switch guard would have already fired. So: just verify
    // Duplicate on a clean builtin doesn't invoke confirm.
    await openWith([makeFormat("SRT", "builtin")], "SRT");
    listFormatsMock.mockResolvedValue([
      makeFormat("SRT", "builtin"),
      makeFormat("SRT (copy)"),
    ]);
    fireEvent.click(screen.getByText(/Duplicate/));
    await waitFor(() => expect(saveFormatMock).toHaveBeenCalled());
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

// ── Delete flow ─────────────────────────────────────────────────────────────

describe("FormatManager: delete", () => {
  function openDeletePopover(container: Element) {
    const trash = container.querySelector(
      '[data-tooltip="Delete format"]',
    ) as HTMLButtonElement;
    fireEvent.click(trash);
  }

  it("shows the confirm popover when the trash icon is clicked", async () => {
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    openDeletePopover(container);
    await waitFor(() => expect(screen.getByText("Delete this format?")).toBeTruthy());
  });

  it("Cancel dismisses the popover without deleting", async () => {
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    openDeletePopover(container);
    await waitFor(() => expect(screen.getByText("Delete this format?")).toBeTruthy());
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText("Delete this format?")).toBeNull());
    expect(deleteFormatMock).not.toHaveBeenCalled();
  });

  it("Delete calls deleteFormat with the editing filename", async () => {
    listFormatsMock.mockResolvedValue([]);
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    openDeletePopover(container);
    await waitFor(() => expect(screen.getByText("Delete this format?")).toBeTruthy());
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(deleteFormatMock).toHaveBeenCalled());
    expect(deleteFormatMock.mock.calls[0][0]).toBe("Custom.cff");
  });

  it("after delete, clears editor to empty state", async () => {
    listFormatsMock.mockResolvedValue([makeFormat("Other")]);
    const { container } = await openWith(
      [makeFormat("Custom"), makeFormat("Other")],
      "Custom",
    );
    openDeletePopover(container);
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() =>
      expect(container.querySelector(".fmt-editor-empty")).toBeTruthy(),
    );
  });

  it("after deleting the last format, editor becomes empty", async () => {
    listFormatsMock.mockResolvedValue([]);
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    openDeletePopover(container);
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() =>
      expect(container.querySelector(".fmt-editor-empty")).toBeTruthy(),
    );
  });

  it("clears selectedExportFormat when the active format is deleted", async () => {
    selectedExportFormat.value = "Custom";
    listFormatsMock.mockResolvedValue([]);
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    openDeletePopover(container);
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(deleteFormatMock).toHaveBeenCalled());
    expect(selectedExportFormat.value).toBe("");
  });

  it("updates selectedExportFormat to a sibling when the active is deleted", async () => {
    selectedExportFormat.value = "Custom";
    listFormatsMock.mockResolvedValue([makeFormat("Other")]);
    await openWith([makeFormat("Custom"), makeFormat("Other")], "Custom");
    const trash = document.querySelector(
      '[data-tooltip="Delete format"]',
    ) as HTMLButtonElement;
    fireEvent.click(trash);
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(selectedExportFormat.value).toBe("Other"));
  });

  it("surfaces delete failures inline", async () => {
    deleteFormatMock.mockImplementationOnce(async () => {
      throw new Error("locked");
    });
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    openDeletePopover(container);
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() =>
      expect(container.querySelector(".fb-error")?.textContent).toMatch(/locked/),
    );
  });
});

// ── Import flow ─────────────────────────────────────────────────────────────

describe("FormatManager: import", () => {
  it("refreshes the list and selects the imported format", async () => {
    importFormatFileMock.mockResolvedValue("Imported");
    listFormatsMock.mockResolvedValue([makeFormat("Imported")]);
    await openWith([]);

    fireEvent.click(screen.getByText("Import"));

    await waitFor(() => expect(importFormatFileMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByDisplayValue("Imported")).toBeTruthy());
  });

  it("does nothing visible when the user cancels the dialog", async () => {
    importFormatFileMock.mockResolvedValue(null);
    const { container } = await openWith([]);
    fireEvent.click(screen.getByText("Import"));
    await waitFor(() => expect(importFormatFileMock).toHaveBeenCalled());
    // No format, editor still empty
    expect(container.querySelector(".fmt-editor-empty")).toBeTruthy();
  });

  it("guards unsaved changes before import", async () => {
    confirmMock.mockResolvedValue("cancel");
    await openWith([makeFormat("Custom")], "Custom");
    fireEvent.input(screen.getByDisplayValue("Custom"), { target: { value: "Dirty" } });
    fireEvent.click(screen.getByText("Import"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(importFormatFileMock).not.toHaveBeenCalled();
  });

  it("surfaces import failures via showError", async () => {
    importFormatFileMock.mockRejectedValue(new Error("bad file"));
    await openWith([]);
    fireEvent.click(screen.getByText("Import"));
    await waitFor(() => expect(showErrorMock).toHaveBeenCalled());
    expect(String(showErrorMock.mock.calls[0][0])).toMatch(/bad file/);
  });
});

// ── Export format file flow ─────────────────────────────────────────────────

describe("FormatManager: export .cff", () => {
  it("calls exportFormatFile with the current format path", async () => {
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    const exportBtn = container.querySelector(
      '[data-tooltip="Export .cff file"]',
    ) as HTMLButtonElement;
    fireEvent.click(exportBtn);
    await waitFor(() => expect(exportFormatFileMock).toHaveBeenCalled());
    expect(exportFormatFileMock.mock.calls[0][0]).toBe("/fake/Custom.cff");
  });

  it("surfaces export failures inline", async () => {
    exportFormatFileMock.mockRejectedValueOnce(new Error("no write"));
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    const exportBtn = container.querySelector(
      '[data-tooltip="Export .cff file"]',
    ) as HTMLButtonElement;
    fireEvent.click(exportBtn);
    await waitFor(() =>
      expect(container.querySelector(".fb-error")?.textContent).toMatch(/no write/),
    );
  });

  it("export button is hidden when the editor is empty", async () => {
    const { container } = await openWith([]);
    expect(container.querySelector('[data-tooltip="Export .cff file"]')).toBeNull();
  });
});

// ── Preview ─────────────────────────────────────────────────────────────────

describe("FormatManager: preview", () => {
  it("shows empty-state when template is empty", async () => {
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    const templateArea = container.querySelector(".fb-editor-textarea") as HTMLTextAreaElement;
    fireEvent.input(templateArea, { target: { value: "" } });
    await waitFor(() => {
      expect(container.querySelector(".fmt-preview-output")).toBeNull();
      expect(container.querySelector(".fmt-preview-empty")).toBeTruthy();
    });
  });

  it("updates preview as the template changes", async () => {
    const { container } = await openWith([makeFormat("Custom")], "Custom");
    const templateArea = container.querySelector(".fb-editor-textarea") as HTMLTextAreaElement;
    fireEvent.input(templateArea, { target: { value: "HEADER\n{{each}}{{text}}|{{/each}}" } });
    await waitFor(() => {
      const preview = container.querySelector(".fmt-preview-output");
      expect(preview?.textContent).toMatch(/^HEADER/);
      expect(preview?.textContent).toContain("Hello world");
    });
  });
});

