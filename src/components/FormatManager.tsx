import { signal } from "@preact/signals";
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import {
  XIcon as X,
  PlusIcon as Plus,
  TrashIcon as Trash,
  CopyIcon as Copy,
  ExportIcon as ExportIcon,
  DownloadSimpleIcon as Import,
  LockIcon as Lock,
} from "@phosphor-icons/react";
import {
  type FormatConfig,
  parseCff,
  serializeCff,
  previewTemplate,
  validateTemplate,
  isValidToken,
  isPerCaptionToken,
  findEachBlocks,
  findInvalidEachOffsets,
} from "../lib/export/builder";
import {
  extractTokenPrefix,
  filterAutocomplete,
  getGrammarForPrefix,
  lookupTokenDescription,
  type AutocompleteSuggestion,
  type GrammarHelp,
} from "../lib/export/autocomplete";
import {
  saveFormat,
  deleteFormat,
  loadFormatSource,
  listFormats,
  exportFormatFile,
  importFormatFile,
  type ExportFormat,
} from "../lib/export";
import {
  validateFormatConfig,
  normalizeFormatConfig,
  uniqueFormatName,
  randomFormatFilename,
  type FieldErrors,
} from "../lib/export/validation";
import { exportFormats, selectedExportFormat } from "../store/app";
import { showError } from "./ErrorModal";
import { showTextTooltip, hideTooltip } from "./Tooltip";
import { confirmUnsavedChanges } from "./UnsavedChanges";

// ── State ───────────────────────────────────────────────────────────────────

export const formatManagerOpen = signal(false);

let _guardLeave: (() => Promise<boolean>) | null = null;

export function openFormatManager() {
  formatManagerOpen.value = true;
}

/** Ask the format manager to close, respecting unsaved-changes guard.
 *  Returns true if it closed, false if the user cancelled. */
export async function requestCloseFormatManager(): Promise<boolean> {
  if (!formatManagerOpen.value) return true;
  if (_guardLeave && !(await _guardLeave())) return false;
  formatManagerOpen.value = false;
  return true;
}

// ── Component ───────────────────────────────────────────────────────────────

const DEFAULT_TEMPLATE = "{{each}}\n\n{{/each}}";

interface AutocompleteState {
  matches: AutocompleteSuggestion[];
  /** Grammar header for the parameterized base (variant mode only). */
  grammar: GrammarHelp | null;
  selected: number;
  coords: { top: number; left: number };
  /** Range of the template text that will be replaced on selection. */
  range: { start: number; end: number };
}

interface EditorState {
  /** null = creating new. string = editing existing file (bare filename). */
  editingFilename: string | null;
  /** Absolute path (for export). null when creating new. */
  formatPath: string | null;
  /** true when viewing a builtin (read-only, can duplicate). */
  readonly: boolean;
  /** Current (possibly-edited) config. */
  config: FormatConfig;
  /** Snapshot of the config as last loaded/saved. Used for dirty comparison. */
  savedConfig: FormatConfig;
}

export function FormatManager() {
  const isOpen = formatManagerOpen.value;
  const formats = exportFormats.value;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [autocomplete, setAutocomplete] = useState<AutocompleteState | null>(null);

  const templateRef = useRef<HTMLTextAreaElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const autocompletePopupRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const focusNameOnNext = useRef(false);
  const autocompleteScheduled = useRef(false);

  // Reset editor state when modal opens — no format pre-selected
  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setConfirmingDelete(false);
    setAutocomplete(null);
    setEditor(null);
    setSelectedId(null);
  }, [isOpen]);

  // Dismiss autocomplete when the edited format changes.
  useEffect(() => {
    setAutocomplete(null);
  }, [editor?.formatPath]);

  // Keep the keyboard-selected autocomplete item visible when arrow nav scrolls
  // beyond the popup's max-height.
  useEffect(() => {
    const popup = autocompletePopupRef.current;
    if (!popup) return;
    const active = popup.querySelector<HTMLElement>(".fb-autocomplete-item--active");
    active?.scrollIntoView({ block: "nearest" });
  }, [autocomplete?.selected]);

  // Dismiss delete confirm on click-outside
  useEffect(() => {
    if (!confirmingDelete) return;
    const dismiss = () => setConfirmingDelete(false);
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, [confirmingDelete]);

  // Focus + select the name field when a new format is created
  useEffect(() => {
    if (editor && focusNameOnNext.current) {
      focusNameOnNext.current = false;
      requestAnimationFrame(() => {
        nameRef.current?.focus();
        nameRef.current?.select();
      });
    }
  }, [editor]);

  // Live preview
  useEffect(() => {
    if (!editor || !editor.config.template.trim()) {
      setPreview("");
      return;
    }
    setPreview(previewTemplate(editor.config));
  }, [editor?.config]);

  const isDirty = (): boolean => {
    if (!editor || editor.readonly) return false;
    return JSON.stringify(editor.config) !== JSON.stringify(editor.savedConfig);
  };

  /**
   * Guards a "leave current editor" action. If there are unsaved edits,
   * prompts the user to save / discard / cancel. Returns true if the caller
   * may proceed with the leave, false if it should abort.
   */
  const guardLeave = async (): Promise<boolean> => {
    if (!isDirty()) return true;
    const choice = await confirmUnsavedChanges(
      "You have unsaved changes to this format. Save before leaving?",
      { title: "Unsaved format changes" },
    );
    if (choice === "cancel") return false;
    if (choice === "discard") return true;
    return await performSave();
  };

  // Expose guard to the module-level requestClose function.
  useEffect(() => {
    _guardLeave = guardLeave;
    return () => { _guardLeave = null; };
  });

  /**
   * Validate + persist the current editor state. Updates `savedConfig` in place
   * so the editor is no longer dirty. Returns true on success, false on
   * validation or write failure (error is surfaced via setError).
   */
  const performSave = async (): Promise<boolean> => {
    if (!editor) return true;
    const errs = validate(editor.config);
    if (Object.keys(errs).length > 0) return false;

    let filename = editor.editingFilename;
    if (!filename || !filename.endsWith(".cff")) {
      filename = randomFormatFilename(formats);
    }

    // Normalize trim-sensitive fields so the on-disk state matches what the
    // Rust parser will hand back on the next list_user_formats call.
    const normalized = normalizeFormatConfig(editor.config);

    const cff = serializeCff(normalized);
    const oldName = editor.savedConfig.name;
    try {
      await saveFormat(filename, cff);
      const fmts = await listFormats();
      exportFormats.value = fmts;
      const saved = fmts.find((f) => f.name === normalized.name);
      if (saved) {
        // If the renamed format was the selected export format, follow it.
        if (selectedExportFormat.value === oldName) {
          selectedExportFormat.value = saved.name;
        }
        setEditor({
          editingFilename: filename,
          formatPath: saved.formatPath,
          readonly: false,
          config: normalized,
          savedConfig: { ...normalized },
        });
        setSelectedId(saved.id);
      }
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  };

  const close = async () => {
    if (!(await guardLeave())) return;
    formatManagerOpen.value = false;
    setSelectedId(null);
    setEditor(null);
  };

  const handleListClick = async (fmt: ExportFormat) => {
    if (fmt.id === selectedId) return;
    if (!(await guardLeave())) return;
    selectFormat(fmt);
  };

  const selectFormat = async (fmt: ExportFormat) => {
    setSelectedId(fmt.id);
    setError(null);
    setConfirmingDelete(false);
    try {
      const source = await loadFormatSource(fmt.formatPath);
      const config = parseCff(source);
      if (!config) {
        showError("This format cannot be opened in the editor.");
        return;
      }
      const filename = fmt.formatPath.replace(/\\/g, "/").split("/").pop() ?? "";
      setEditor({
        editingFilename: filename,
        formatPath: fmt.formatPath,
        readonly: fmt.source === "builtin",
        config,
        savedConfig: { ...config },
      });
    } catch (e) {
      showError(`Failed to load format: ${e}`);
    }
  };

  const startNew = async () => {
    if (!(await guardLeave())) return;
    const name = uniqueFormatName("New format", formats);
    const config: FormatConfig = { name, extension: "txt", template: DEFAULT_TEMPLATE };
    const filename = randomFormatFilename(formats);
    const cff = serializeCff(config);
    try {
      await saveFormat(filename, cff);
      const fmts = await listFormats();
      exportFormats.value = fmts;
      const created = fmts.find((f) => f.name === name);
      if (created) {
        focusNameOnNext.current = true;
        selectFormat(created);
      }
    } catch (e) {
      showError(String(e));
    }
  };

  const update = useCallback((field: keyof FormatConfig, value: string) => {
    setEditor((prev) => prev ? { ...prev, config: { ...prev.config, [field]: value } } : prev);
    setError(null);
  }, []);

  const validate = (config: FormatConfig): FieldErrors =>
    validateFormatConfig(config, formats, editor?.formatPath ?? null);

  const handleSave = () => { performSave(); };

  const handleDuplicate = async () => {
    if (!editor) return;
    // Duplicate from the saved snapshot, not the in-memory edits — guardLeave
    // has already resolved whether those edits should be saved or discarded.
    if (!(await guardLeave())) return;
    const baseConfig = editor.savedConfig;
    const name = uniqueFormatName(`${baseConfig.name} (copy)`, formats);
    const config = { ...baseConfig, name };
    const filename = randomFormatFilename(formats);
    const cff = serializeCff(config);
    try {
      await saveFormat(filename, cff);
      const fmts = await listFormats();
      exportFormats.value = fmts;
      const created = fmts.find((f) => f.name === name);
      if (created) selectFormat(created);
    } catch (e) {
      showError(String(e));
    }
  };

  const handleDelete = async () => {
    if (!editor?.editingFilename) return;
    try {
      await deleteFormat(editor.editingFilename);
      const fmts = await listFormats();
      exportFormats.value = fmts;
      if (selectedExportFormat.value === editor.savedConfig.name) {
        selectedExportFormat.value = fmts[0]?.name ?? "";
      }
      setEditor(null);
      setSelectedId(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleImport = async () => {
    if (!(await guardLeave())) return;
    try {
      const name = await importFormatFile();
      if (name) {
        const fmts = await listFormats();
        exportFormats.value = fmts;
        const imported = fmts.find((f) => f.name === name);
        if (imported) selectFormat(imported);
      }
    } catch (e) {
      showError(String(e));
    }
  };

  // ── Template autocomplete ────────────────────────────────────────────────

  const refreshAutocomplete = () => {
    if (!editor || editor.readonly) { setAutocomplete(null); return; }
    const ta = templateRef.current;
    if (!ta || document.activeElement !== ta) { setAutocomplete(null); return; }
    const caret = ta.selectionStart ?? 0;
    const range = extractTokenPrefix(editor.config.template, caret);
    if (!range) { setAutocomplete(null); return; }
    const matches = filterAutocomplete(range.prefix);
    const grammar = getGrammarForPrefix(range.prefix);
    // Keep the popup open whenever there's *anything* to show — either
    // suggestion items or a grammar header for a known parameterized base.
    if (matches.length === 0 && !grammar) { setAutocomplete(null); return; }
    const coords = getCaretCoords(ta, caret);
    setAutocomplete({ matches, grammar, selected: 0, coords, range });
  };

  const scheduleAutocompleteRefresh = () => {
    if (autocompleteScheduled.current) return;
    autocompleteScheduled.current = true;
    requestAnimationFrame(() => {
      autocompleteScheduled.current = false;
      refreshAutocomplete();
    });
  };

  const insertAutocompleteSelection = (match?: AutocompleteSuggestion) => {
    if (!autocomplete || !editor) return;
    const chosen = match ?? autocomplete.matches[autocomplete.selected];
    if (!chosen) return;
    const template = editor.config.template;
    const { text, caretOffset } = expandEachInsertion(chosen.def.token, template, autocomplete.range);
    const before = template.slice(0, autocomplete.range.start);
    const after = template.slice(autocomplete.range.end);
    update("template", before + text + after);
    setAutocomplete(null);
    const pos = autocomplete.range.start + caretOffset;
    requestAnimationFrame(() => {
      const ta = templateRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  // Hover tooltips on highlighted tokens. The textarea sits on top of the
  // backdrop, so native `title=` on the highlight spans never triggers —
  // we drive the global Tooltip by iterating the spans geometrically.
  const handleTemplateMouseMove = (e: MouseEvent) => {
    const backdrop = backdropRef.current;
    if (!backdrop) { hideTooltip(); return; }
    const spans = backdrop.querySelectorAll<HTMLElement>(".fb-hl-valid, .fb-hl-invalid");
    const x = e.clientX;
    const y = e.clientY;
    for (const span of Array.from(spans)) {
      const title = span.getAttribute("title");
      if (!title) continue;
      for (const r of Array.from(span.getClientRects())) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          showTextTooltip(title, r.left + r.width / 2, r.top, r.bottom);
          return;
        }
      }
    }
    hideTooltip();
  };

  const handleTemplateMouseLeave = () => hideTooltip();

  const handleTemplateKeyDown = (e: KeyboardEvent) => {
    if (!autocomplete) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setAutocomplete(null);
      return;
    }
    const n = autocomplete.matches.length;
    if (n === 0) return; // grammar-only popup: nothing to navigate or insert
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAutocomplete({ ...autocomplete, selected: (autocomplete.selected + 1) % n });
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setAutocomplete({ ...autocomplete, selected: (autocomplete.selected - 1 + n) % n });
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insertAutocompleteSelection();
      return;
    }
  };

  if (!isOpen) return null;

  const builtins = formats.filter((f) => f.source === "builtin");
  const custom = formats.filter((f) => f.source === "custom");
  const dirty = isDirty();
  const fieldErrors: FieldErrors = editor && !editor.readonly ? validate(editor.config) : {};
  const isValid = Object.keys(fieldErrors).length === 0;

  const renderListItem = (f: ExportFormat) => (
    <button
      key={f.id}
      class={`fmt-list-item${selectedId === f.id ? " fmt-list-item--active" : ""}`}
      onClick={() => handleListClick(f)}
    >
      <span class="fmt-list-item-name">{f.name}</span>
      {selectedId === f.id && dirty && <span class="fmt-list-item-dot" aria-label="Unsaved changes" />}
    </button>
  );

  return (
    <div class="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="fmt-manager">
        {/* Header */}
        <div class="fmt-manager-header">
          <span class="fmt-manager-title">Export formats</span>
          <button class="btn btn-ghost btn-icon" onClick={close}><X size={14} /></button>
        </div>

        <div class="fmt-manager-body">
          {/* Left pane — Format list */}
          <div class="fmt-list-pane">
            <div class="fmt-list scrollable">
              {builtins.map(renderListItem)}
              {builtins.length > 0 && custom.length > 0 && (
                <div class="fmt-list-divider" />
              )}
              {custom.map(renderListItem)}
            </div>
            <div class="fmt-list-actions">
              <button class="btn btn-ghost btn-sm" onClick={startNew}><Plus size={12} /> New</button>
              <button class="btn btn-ghost btn-sm" onClick={handleImport}><Import size={12} /> Import</button>
            </div>
          </div>

          {/* Center pane — Editor */}
          <div class="fmt-editor-pane">
            {editor ? (
              <>
                <div class="fmt-editor-fields scrollable">
                  {editor.readonly && (
                    <div class="fmt-editor-readonly-banner">
                      <Lock size={12} />
                      <span>Built-in format — duplicate to customize.</span>
                    </div>
                  )}
                  {/* Name + Extension row */}
                  <div class="fb-row fb-row--inline">
                    <div class="fb-field fb-field--grow">
                      <label class="fb-label">Name</label>
                      <input
                        ref={nameRef}
                        class={`fb-input${fieldErrors.name ? " fb-input--error" : ""}`}
                        type="text"
                        value={editor.config.name}
                        placeholder="My Format"
                        disabled={editor.readonly}
                        onInput={(e) => update("name", (e.target as HTMLInputElement).value)}
                      />
                      {fieldErrors.name && <span class="fb-field-error">{fieldErrors.name}</span>}
                    </div>
                    <div class="fb-field fb-field--ext">
                      <label class="fb-label">Extension</label>
                      <input
                        class={`fb-input${fieldErrors.extension ? " fb-input--error" : ""}`}
                        type="text"
                        value={editor.config.extension}
                        placeholder="srt"
                        disabled={editor.readonly}
                        onInput={(e) => update("extension", (e.target as HTMLInputElement).value)}
                      />
                      {fieldErrors.extension && <span class="fb-field-error">{fieldErrors.extension}</span>}
                    </div>
                  </div>

                  {/* Template */}
                  <div class="fb-field fb-field--fill">
                    <div class="fb-label-row">
                      <label class="fb-label">Template</label>
                      {!editor.readonly && (
                        <span class="fb-label-hint">Type <code>{"{{"}</code> for token suggestions</span>
                      )}
                    </div>
                    <div class={`fb-editor${fieldErrors.template ? " fb-editor--error" : ""}`}>
                      <div
                        ref={backdropRef}
                        class="fb-editor-backdrop fb-textarea fb-textarea--lg"
                        dangerouslySetInnerHTML={{ __html: highlightTokens(editor.config.template) + "\n" }}
                      />
                      <textarea
                        ref={templateRef}
                        class="fb-editor-textarea fb-textarea fb-textarea--lg"
                        value={editor.config.template}
                        placeholder={"{{each}}\n{{index:1}}\n{{start:HH:mm:ss,SSS}} --> {{end:HH:mm:ss,SSS}}\n{{text}}\n\n{{/each}}"}
                        disabled={editor.readonly}
                        spellcheck={false}
                        onInput={(e) => {
                          update("template", (e.target as HTMLTextAreaElement).value);
                          scheduleAutocompleteRefresh();
                        }}
                        onKeyDown={handleTemplateKeyDown}
                        onKeyUp={(e) => {
                          if (["ArrowDown", "ArrowUp", "Tab", "Enter", "Escape"].includes(e.key)) return;
                          scheduleAutocompleteRefresh();
                        }}
                        onClick={scheduleAutocompleteRefresh}
                        onFocus={scheduleAutocompleteRefresh}
                        onBlur={() => {
                          // Delay so click on a popup item fires first.
                          setTimeout(() => setAutocomplete(null), 150);
                        }}
                        onScroll={(e) => {
                          if (backdropRef.current) {
                            backdropRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
                            backdropRef.current.scrollLeft = (e.target as HTMLTextAreaElement).scrollLeft;
                          }
                          setAutocomplete(null);
                          hideTooltip();
                        }}
                        onMouseMove={handleTemplateMouseMove}
                        onMouseLeave={handleTemplateMouseLeave}
                      />
                      {autocomplete && (
                        <div
                          ref={autocompletePopupRef}
                          class="fb-autocomplete"
                          style={`top:${autocomplete.coords.top}px;left:${autocomplete.coords.left}px`}
                          onMouseDown={(e) => e.preventDefault()}
                        >
                          {autocomplete.grammar && (
                            <div class="fb-autocomplete-grammar">
                              <code class="fb-autocomplete-grammar-sig">{autocomplete.grammar.signature}</code>
                              {autocomplete.grammar.lines.map((line, i) => (
                                <div key={i} class="fb-autocomplete-grammar-line">{line}</div>
                              ))}
                            </div>
                          )}
                          {autocomplete.grammar && autocomplete.matches.length > 0 && (
                            <div class="fb-autocomplete-divider" />
                          )}
                          {autocomplete.matches.map((s, i) => (
                            <button
                              key={s.def.token}
                              class={`fb-autocomplete-item${i === autocomplete.selected ? " fb-autocomplete-item--active" : ""}`}
                              onMouseEnter={() => setAutocomplete({ ...autocomplete, selected: i })}
                              onClick={() => insertAutocompleteSelection(s)}
                            >
                              <code class="fb-token-code">{s.def.display ?? s.def.token}</code>
                              <span class="fb-token-desc">{s.def.description}</span>
                              {s.hasVariants && (
                                <span class="fb-autocomplete-hint">type <code>:</code> for variants</span>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {fieldErrors.template && <span class="fb-field-error">{fieldErrors.template}</span>}
                    <TokenWarnings value={editor.config.template} />
                  </div>

                  {error && <div class="fb-error">{error}</div>}
                </div>

                {/* Editor footer */}
                <div class="fmt-editor-footer">
                  {editor.editingFilename && !editor.readonly && (
                    <div style="position:relative">
                      <button class="btn btn-ghost btn-icon" data-tooltip="Delete format" onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }}>
                        <Trash size={14} />
                      </button>
                      {confirmingDelete && (
                        <div class="fmt-delete-popover" onClick={(e) => e.stopPropagation()}>
                          <span class="fmt-delete-popover-label">Delete this format?</span>
                          <div class="fmt-delete-popover-actions">
                            <button class="btn btn-ghost btn-sm" onClick={() => setConfirmingDelete(false)}>Cancel</button>
                            <button class="btn btn-danger-ghost btn-sm" onClick={handleDelete}>Delete</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {editor.editingFilename && editor.formatPath && (
                    <button
                      class="btn btn-ghost btn-icon"
                      data-tooltip="Export .cff file"
                      onClick={async () => {
                        try { await exportFormatFile(editor.formatPath!); }
                        catch (e) { setError(String(e)); }
                      }}
                    >
                      <ExportIcon size={14} />
                    </button>
                  )}
                  <div style="flex:1" />
                  <button class="btn btn-ghost btn-sm" onClick={handleDuplicate}>
                    <Copy size={12} /> Duplicate
                  </button>
                  {!editor.readonly && (
                    <button class="btn btn-primary btn-sm" onClick={handleSave} disabled={!dirty || !isValid}>
                      Save
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div class="fmt-editor-empty">
                <span class="empty-state-body">Select a format to view or edit.</span>
              </div>
            )}
          </div>

          {/* Right pane — Live preview */}
          <div class="fmt-preview-pane">
            <label class="fb-label">Preview</label>
            {preview ? (
              <pre class="fmt-preview-output scrollable">{preview}</pre>
            ) : (
              <div class="fmt-preview-empty">
                <span class="empty-state-body">{editor ? "Preview will appear as you type." : ""}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function TokenWarnings({ value }: { value: string }) {
  const warnings = validateTemplate(value);
  if (warnings.length === 0) return null;
  return (
    <div class="fb-token-warnings">
      {warnings.map((w, i) => (
        <span key={i} class="fb-token-warning">{w.message}</span>
      ))}
    </div>
  );
}

/**
 * When inserting `{{each}}` at a top-level position, expand to a paired block
 * with a blank line in between and land the caret on that blank line. If the
 * insertion point is already inside an existing `{{each}}...{{/each}}` block,
 * insert verbatim — pairing would create unsupported nesting.
 */
function expandEachInsertion(
  token: string,
  template: string,
  range: { start: number; end: number },
): { text: string; caretOffset: number } {
  if (token !== "{{each}}") {
    return { text: token, caretOffset: token.length };
  }
  const remaining = template.slice(0, range.start) + template.slice(range.end);
  const insideBlock = findEachBlocks(remaining).some(
    (b) => range.start > b.open && range.start < b.close,
  );
  if (insideBlock) {
    return { text: token, caretOffset: token.length };
  }
  return { text: "{{each}}\n\n{{/each}}", caretOffset: "{{each}}\n".length };
}

/**
 * Compute viewport coordinates (top/left in px) of the caret position inside
 * a textarea. Uses a hidden mirror div that duplicates the textarea's metrics
 * to measure where a zero-width marker lands.
 */
function getCaretCoords(
  textarea: HTMLTextAreaElement,
  pos: number,
): { top: number; left: number } {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const copied = [
    "boxSizing", "width",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
    "lineHeight", "textTransform", "wordSpacing", "textIndent",
    "whiteSpace", "wordWrap", "tabSize", "wordBreak",
  ];
  for (const p of copied) {
    (mirror.style as unknown as Record<string, string>)[p] =
      (style as unknown as Record<string, string>)[p];
  }
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.overflow = "hidden";

  mirror.textContent = textarea.value.substring(0, pos);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const taRect = textarea.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;

  const top = taRect.top + (markerRect.top - mirrorRect.top) - textarea.scrollTop + lineHeight;
  const left = taRect.left + (markerRect.left - mirrorRect.left) - textarea.scrollLeft;

  document.body.removeChild(mirror);
  return { top, left };
}

function highlightTokens(template: string): string {
  const escaped = template.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const blocks = findEachBlocks(escaped);
  const badEach = findInvalidEachOffsets(escaped);

  return escaped.replace(/\{\{([^}]+)\}\}/g, (_full, key: string, offset: number) => {
    const safeKey = key.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (!isValidToken(key)) {
      return `<span class="fb-hl-invalid">{{${safeKey}}}</span>`;
    }
    if ((key === "each" || key === "/each") && badEach.has(offset)) {
      const title = key === "each"
        ? "{{each}} must have a matching {{/each}} and can't be nested"
        : "{{/each}} must close a matching {{each}}";
      return `<span class="fb-hl-invalid" title="${title}">{{${safeKey}}}</span>`;
    }
    if (isPerCaptionToken(key)) {
      const insideBlock = blocks.some((b) => offset > b.open && offset < b.close);
      if (!insideBlock) {
        return `<span class="fb-hl-invalid" title="Per-caption token must appear inside {{each}}...{{/each}}">{{${safeKey}}}</span>`;
      }
    }
    const desc = lookupTokenDescription(key);
    const titleAttr = desc ? ` title="${desc.replace(/"/g, "&quot;")}"` : "";
    return `<span class="fb-hl-valid"${titleAttr}>{{${safeKey}}}</span>`;
  });
}

