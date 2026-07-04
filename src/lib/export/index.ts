import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import type { CaptionBlock, StyleSpan } from "../../types/project";
import { executeTemplate, parseCff, serializeCff, type FormatConfig } from "./builder";
import { uniqueFormatName, randomFormatFilename } from "./validation";
import { isKnownSpanStyle } from "../spans";
import { showNotice } from "../../components/NoticeModal";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExportFormat {
  id: string;
  name: string;
  extension: string;
  /** Absolute path to the .cff file. */
  formatPath: string;
  /** "builtin" for seeded formats, "custom" for user-created .cff. */
  source: "builtin" | "custom";
}

/** The shape passed into template execution. */
export interface SerializedCaption {
  index: number;
  start: number;    // seconds
  end: number;      // seconds
  lines: string[];
  /** Inline styling overlay, present only when the caption carries spans.
   *  Consumed by {{text}} (via the format's styles mapping) and {{json}}. */
  spans?: StyleSpan[];
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Return all format files from the user's export_formats directory. */
export async function listFormats(): Promise<ExportFormat[]> {
  try {
    const meta = await invoke<Array<{ name: string; extension: string; path: string; source: string }>>(
      "list_user_formats",
    );
    return meta.map((f) => ({
      id: f.name,
      name: f.name,
      extension: f.extension,
      formatPath: f.path,
      source: (f.source === "builtin" ? "builtin" : "custom") as ExportFormat["source"],
    }));
  } catch {
    return [];
  }
}

function serialize(captions: CaptionBlock[]): SerializedCaption[] {
  return captions.map((c) => ({
    index: c.index,
    start: c.start,
    end: c.end,
    lines: c.lines,
    ...(c.spans && c.spans.length > 0 ? { spans: c.spans } : {}),
  }));
}

/** True when captions carry styling this version understands but the format
 *  maps none of it — the export silently emits plain text, which deserves a
 *  one-line heads-up (covers pre-0.7.0 duplicated builtins that never gain
 *  the new styles blocks). */
function stylingDropped(config: FormatConfig, captions: SerializedCaption[]): boolean {
  if (config.styles && Object.keys(config.styles).length > 0) return false;
  if (!config.template.includes("{{text")) return false;
  return captions.some((c) => (c.spans ?? []).some((s) => isKnownSpanStyle(s.style)));
}

/** Per-format "don't remind me again" persistence (app preference, never in
 *  the .cod). The warning accompanies EVERY affected export until the user
 *  checks the box for that format; keyed by name, so renaming re-arms it. */
const STYLING_NOTICE_KEY = "codfish:stylingNoticeDismissed";

function stylingNoticeDismissals(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(STYLING_NOTICE_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function isStylingNoticeDismissed(formatName: string): boolean {
  return stylingNoticeDismissals().has(formatName);
}

export function dismissStylingNotice(formatName: string): void {
  const next = stylingNoticeDismissals();
  next.add(formatName);
  try { localStorage.setItem(STYLING_NOTICE_KEY, JSON.stringify([...next])); } catch { /* best-effort */ }
}

/** Forget a format's dismissal (called when the format is deleted, so an
 *  unrelated future format with the same name doesn't inherit the silence). */
export function clearStylingNoticeDismissal(formatName: string): void {
  const next = stylingNoticeDismissals();
  if (!next.delete(formatName)) return;
  try { localStorage.setItem(STYLING_NOTICE_KEY, JSON.stringify([...next])); } catch { /* best-effort */ }
}

export function stylingDroppedMessage(formatName: string): string {
  return `"${formatName}" has no style mappings, so inline styling was exported as plain text. Add mappings in Edit → Export Formats.`;
}

export const STYLING_NOTICE_CHECKBOX = "Don't remind me again for this format";

function noticeStylingDropped(format: ExportFormat) {
  if (isStylingNoticeDismissed(format.name)) return;
  showNotice("Styling not exported", stylingDroppedMessage(format.name), {
    checkboxLabel: STYLING_NOTICE_CHECKBOX,
    onDismiss: (checked) => { if (checked) dismissStylingNotice(format.name); },
  });
}

/** Execute a format's template and prompt the user for a save path. */
export async function exportCaptions(
  format: ExportFormat,
  captions: CaptionBlock[],
  baseName: string,
  fps: number,
  dropFrame = false,
): Promise<void> {
  const config = await loadFormatConfig(format.formatPath);
  const serialized = serialize(captions);
  const content = executeTemplate(config.template, serialized, fps, dropFrame, {
    styles: config.styles,
    escape: config.escape,
  });

  const savePath = await save({
    title: "Export Captions",
    filters: [{ name: format.name, extensions: [format.extension] }],
    defaultPath: `${baseName}.${format.extension}`,
  });
  if (!savePath) return;

  await invoke<void>("save_project", { path: savePath, json: content });

  if (stylingDropped(config, serialized)) noticeStylingDropped(format);
}

export interface BulkExportItem {
  name: string;          // base filename (no extension)
  captions: CaptionBlock[];
  fps: number;
  dropFrame: boolean;
}

export interface BulkExportResult {
  folder: string;
  written: string[];                       // filenames written
  failed: { name: string; error: string }[];
  /** True when at least one written item carried styling the format maps
   *  none of. The CALLER surfaces this (composed into its completion modal)
   *  — showing a notice here would collide with the caller's own notice on
   *  the single noticeModal signal and never render. */
  stylingDropped: boolean;
}

/** Prompt once for a destination folder, then write one caption file per item
 * into it (named `<base>.<ext>`). Within-batch name collisions are deduped
 * (clip, clip-1, …). Returns null if the user cancels the folder picker. */
export async function exportCaptionsBulk(
  format: ExportFormat,
  items: BulkExportItem[],
): Promise<BulkExportResult | null> {
  const picked = await open({
    title: "Export all captions to folder…",
    directory: true,
    multiple: false,
  });
  const folder = Array.isArray(picked) ? picked[0] : picked;
  if (!folder) return null;

  const written: string[] = [];
  const failed: { name: string; error: string }[] = [];
  const used = new Set<string>();
  if (items.length === 0) return { folder, written, failed, stylingDropped: false };

  // One config load for the whole batch. A load failure fails every item —
  // reported through `failed`, preserving the function's no-throw contract.
  let config: FormatConfig;
  try {
    config = await loadFormatConfig(format.formatPath);
  } catch (e) {
    return {
      folder,
      written,
      failed: items.map((i) => ({ name: i.name, error: String(e) })),
      stylingDropped: false,
    };
  }
  let droppedStyling = false;
  for (const item of items) {
    try {
      const serialized = serialize(item.captions);
      const content = executeTemplate(config.template, serialized, item.fps, item.dropFrame, {
        styles: config.styles,
        escape: config.escape,
      });
      droppedStyling ||= stylingDropped(config, serialized);
      let base = item.name;
      let n = 1;
      while (used.has(base.toLowerCase())) base = `${item.name}-${n++}`;
      used.add(base.toLowerCase());
      const filename = `${base}.${format.extension}`;
      const path = await join(folder, filename);
      await invoke<void>("save_project", { path, json: content });
      written.push(filename);
    } catch (e) {
      failed.push({ name: item.name, error: String(e) });
    }
  }

  return { folder, written, failed, stylingDropped: droppedStyling };
}

// ── Format file operations ──────────────────────────────────────────────────

/** Save a .cff format file. Returns the absolute path of the written file. */
export async function saveFormat(filename: string, content: string): Promise<string> {
  return invoke<string>("save_user_format", { filename, content });
}

/** Delete a .cff format file. */
export async function deleteFormat(filename: string): Promise<void> {
  await invoke<void>("delete_user_format", { filename });
}

/** Load the raw source of a format file. */
export async function loadFormatSource(formatPath: string): Promise<string> {
  return invoke<string>("load_project", { path: formatPath });
}

// ── Import / export format files ────────────────────────────────────────────

/**
 * Import a .cff format file from disk.
 * Deduplicates name and filename against existing formats.
 * Returns the new format name, or null if cancelled.
 */
export async function importFormatFile(): Promise<string | null> {
  const result = await open({
    filters: [{ name: "Codfish Export Format", extensions: ["cff"] }],
    multiple: false,
  });
  if (!result) return null;

  const content = await invoke<string>("load_project", { path: result });
  const config = parseCff(content);
  if (!config) throw new Error("Invalid .cff format file.");

  const existing = await listFormats();
  const name = uniqueFormatName(config.name, existing);
  const filename = randomFormatFilename(existing);
  const cff = serializeCff({ ...config, name });
  await saveFormat(filename, cff);
  return name;
}

/** Export a .cff format file to a user-chosen location. */
export async function exportFormatFile(formatPath: string): Promise<void> {
  const source = await invoke<string>("load_project", { path: formatPath });
  const config = parseCff(source);
  if (!config) throw new Error("Invalid .cff format file.");

  const savePath = await save({
    defaultPath: `${config.name}.cff`,
    filters: [{ name: "Codfish Export Format", extensions: ["cff"] }],
  });
  if (!savePath) return;

  await invoke<void>("save_project", { path: savePath, json: source });
}

// ── Format execution ────────────────────────────────────────────────────────

async function loadFormatConfig(formatPath: string): Promise<FormatConfig> {
  const source = await invoke<string>("load_project", { path: formatPath });
  const config = parseCff(source);
  if (!config) throw new Error(`Invalid .cff format file: "${formatPath}"`);
  return config;
}
