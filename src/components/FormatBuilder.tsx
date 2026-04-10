import { signal } from "@preact/signals";
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { XIcon as X, PlusIcon as Plus, TrashIcon as Trash } from "@phosphor-icons/react";
import {
  type FormatConfig,
  TOKEN_GROUPS,
  parseCff,
  serializeCff,
  previewTemplate,
  validateTemplate,
  isValidToken,
  isPerCaptionToken,
} from "../lib/export/builder";
import { saveFormat, deleteFormat, loadFormatSource, listFormats } from "../lib/export";
import { exportFormats } from "../store/app";
import { showError } from "./ErrorModal";

// ── State ───────────────────────────────────────────────────────────────────

export interface FormatBuilderState {
  /** null = creating new format. string = editing existing file (bare filename). */
  editingFilename: string | null;
  /** true when viewing a builtin format (read-only, can duplicate). */
  readonly: boolean;
}

export const formatBuilderOpen = signal<FormatBuilderState | null>(null);

export function openFormatBuilderNew() {
  formatBuilderOpen.value = { editingFilename: null, readonly: false };
}

export async function openFormatBuilderEdit(formatPath: string, isBuiltin = false) {
  try {
    const source = await loadFormatSource(formatPath);

    const config = parseCff(source);
    if (!config) {
      showError("This format cannot be opened in the editor.");
      return;
    }

    const filename = formatPath.replace(/\\/g, "/").split("/").pop() ?? "";
    formatBuilderOpen.value = { editingFilename: filename, readonly: isBuiltin };
    _pendingConfig = config;
  } catch (e) {
    showError(`Failed to load format: ${e}`);
  }
}

let _pendingConfig: FormatConfig | null = null;

// ── Component ───────────────────────────────────────────────────────────────

const DEFAULT_TEMPLATE = "{{#each}}\n\n{{/each}}";

const EMPTY_CONFIG: FormatConfig = {
  name: "",
  extension: "",
  template: DEFAULT_TEMPLATE,
};

export function FormatBuilder() {
  const state = formatBuilderOpen.value;
  if (!state) return null;

  const isEditing = state.editingFilename !== null;
  const isReadonly = state.readonly;

  const [config, setConfig] = useState<FormatConfig>(() => {
    if (_pendingConfig) {
      const c = _pendingConfig;
      _pendingConfig = null;
      return c;
    }
    return { ...EMPTY_CONFIG };
  });

  const [preview, setPreview] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tokenMenuOpen, setTokenMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const templateRef = useRef<HTMLTextAreaElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (_pendingConfig) {
      setConfig(_pendingConfig);
      _pendingConfig = null;
    }
    setError(null);
    setConfirmingDelete(false);
  }, [state]);

  // Live preview
  useEffect(() => {
    if (!config.template.trim()) {
      setPreview("");
      return;
    }
    setPreview(previewTemplate(config));
  }, [config]);

  const close = () => { formatBuilderOpen.value = null; };

  const update = useCallback((field: keyof FormatConfig, value: string) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
    setError(null);
  }, []);

  const validate = (): string | null => {
    if (!config.name.trim()) return "Name is required.";
    if (!config.extension.trim()) return "File extension is required.";
    if (!config.template.trim()) return "Template is required.";
    // Warn if no #each and no global-only tokens
    const hasEach = config.template.includes("{{#each}}") && config.template.includes("{{/each}}");
    const hasGlobal = /\{\{(?:json|count)\}\}/.test(config.template);
    if (!hasEach && !hasGlobal) return "Template needs {{#each}}...{{/each}} to output captions.";
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }

    // If editing an existing .cff, keep the filename. Otherwise generate one.
    let filename = state.editingFilename;
    if (!filename || !filename.endsWith(".cff")) {
      filename = `${slugify(config.name)}.cff`;
    }

    const cff = serializeCff(config);

    try {
      await saveFormat(filename, cff);
      const formats = await listFormats();
      exportFormats.value = formats;
      close();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDuplicate = () => {
    formatBuilderOpen.value = { editingFilename: null, readonly: false };
    _pendingConfig = { ...config, name: `${config.name} (copy)` };
  };

  const handleDelete = async () => {
    if (!state.editingFilename) return;
    try {
      await deleteFormat(state.editingFilename);
      const formats = await listFormats();
      exportFormats.value = formats;
      close();
    } catch (e) {
      setError(String(e));
    }
  };

  const insertToken = (token: string) => {
    const textarea = templateRef.current;
    if (textarea) {
      const start = textarea.selectionStart ?? config.template.length;
      const end = textarea.selectionEnd ?? start;
      const before = config.template.slice(0, start);
      const after = config.template.slice(end);
      update("template", before + token + after);
      requestAnimationFrame(() => {
        const pos = start + token.length;
        textarea.focus();
        textarea.setSelectionRange(pos, pos);
      });
    } else {
      update("template", config.template + token);
    }
    setTokenMenuOpen(false);
  };

  return (
    <div class="modal-backdrop" onClick={close}>
      <div class="format-builder" onClick={(e) => e.stopPropagation()}>
        <div class="format-builder-header">
          <span class="format-builder-title">
            {isReadonly ? "View export format" : isEditing ? "Edit export format" : "Create export format"}
          </span>
          <button class="btn btn-ghost btn-icon" onClick={close}><X size={14} /></button>
        </div>

        <div class="format-builder-body">
          {/* Name + Extension row */}
          <div class="fb-row fb-row--inline">
            <div class="fb-field fb-field--grow">
              <label class="fb-label">Name</label>
              <input
                class="fb-input"
                type="text"
                value={config.name}
                placeholder="My Format"
                disabled={isReadonly}
                onInput={(e) => update("name", (e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="fb-field fb-field--ext">
              <label class="fb-label">Extension</label>
              <input
                class="fb-input"
                type="text"
                value={config.extension}
                placeholder="srt"
                disabled={isReadonly}
                onInput={(e) => update("extension", (e.target as HTMLInputElement).value)}
              />
            </div>
          </div>

          {/* Template */}
          <div class="fb-field">
            <label class="fb-label">Template</label>
            <div class="fb-editor">
              <div
                ref={backdropRef}
                class="fb-editor-backdrop fb-textarea fb-textarea--lg"
                dangerouslySetInnerHTML={{ __html: highlightTokens(config.template) + "\n" }}
              />
              <textarea
                ref={templateRef}
                class="fb-editor-textarea fb-textarea fb-textarea--lg"
                value={config.template}
                placeholder={"{{#each}}\n{{index:1}}\n{{start:HH:mm:ss,SSS}} --> {{end:HH:mm:ss,SSS}}\n{{text}}\n\n{{/each}}"}
                disabled={isReadonly}
                spellcheck={false}
                onInput={(e) => update("template", (e.target as HTMLTextAreaElement).value)}
                onScroll={(e) => {
                  if (backdropRef.current) {
                    backdropRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
                    backdropRef.current.scrollLeft = (e.target as HTMLTextAreaElement).scrollLeft;
                  }
                }}
              />
            </div>
            <TokenWarnings value={config.template} />
          </div>

          {/* Token inserter */}
          {!isReadonly && <div class="fb-token-row">
            <button
              class="btn btn-ghost btn-sm"
              onClick={() => setTokenMenuOpen(!tokenMenuOpen)}
            >
              <Plus size={12} /> Insert token
            </button>
            {tokenMenuOpen && (
              <div class="fb-token-menu">
                {TOKEN_GROUPS.map((g) => (
                  <div key={g.group} class="fb-token-group">
                    <div class="fb-token-group-label">{g.group}</div>
                    {g.tokens.map((t) => (
                      <button
                        key={t.token}
                        class="fb-token-item"
                        onClick={() => insertToken(t.token)}
                      >
                        <code class="fb-token-code">{t.token}</code>
                        <span class="fb-token-desc">{t.description}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>}

          {/* Preview */}
          {preview && (
            <div class="fb-field">
              <label class="fb-label">Preview</label>
              <pre class="fb-preview">{preview}</pre>
            </div>
          )}

          {error && <div class="fb-error">{error}</div>}
        </div>

        <div class="format-builder-footer">
          {isEditing && !isReadonly && (
            confirmingDelete ? (
              <div class="fb-delete-confirm">
                <span class="fb-delete-label">Delete this format?</span>
                <button class="btn btn-ghost btn-sm" onClick={() => setConfirmingDelete(false)}>Cancel</button>
                <button class="btn btn-danger btn-sm" onClick={handleDelete}>Delete</button>
              </div>
            ) : (
              <button class="btn btn-ghost btn-icon" data-tooltip="Delete format" onClick={() => setConfirmingDelete(true)}>
                <Trash size={14} />
              </button>
            )
          )}
          <div style="flex:1" />
          <button class="btn btn-secondary" onClick={close}>{isReadonly ? "Close" : "Cancel"}</button>
          {isReadonly ? (
            <button class="btn btn-primary" onClick={handleDuplicate}>Duplicate</button>
          ) : (
            <button class="btn btn-primary" onClick={handleSave}>
              {isEditing ? "Save" : "Create format"}
            </button>
          )}
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

function highlightTokens(template: string): string {
  const escaped = template.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Find the {{#each}}...{{/each}} range in the escaped string
  const eachStart = escaped.indexOf("{{#each}}");
  const eachEnd = escaped.indexOf("{{/each}}");
  const hasBlock = eachStart !== -1 && eachEnd !== -1 && eachStart < eachEnd;

  return escaped.replace(/\{\{([^}]+)\}\}/g, (_full, key: string, offset: number) => {
    const safeKey = key.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (!isValidToken(key)) {
      return `<span class="fb-hl-invalid">{{${safeKey}}}</span>`;
    }
    // Per-caption token outside {{#each}} block = contextually invalid
    if (hasBlock && isPerCaptionToken(key)) {
      const insideBlock = offset > eachStart && offset < eachEnd;
      if (!insideBlock) {
        return `<span class="fb-hl-invalid">{{${safeKey}}}</span>`;
      }
    }
    return `<span class="fb-hl-valid">{{${safeKey}}}</span>`;
  });
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    || "format";
}
