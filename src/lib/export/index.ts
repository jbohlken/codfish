import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import type { CaptionBlock } from "../../types/project";
import { executeTemplate, parseCff, serializeCff } from "./builder";
import { uniqueFormatName, randomFormatFilename } from "./validation";

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
  }));
}

/** Execute a format's template and prompt the user for a save path. */
export async function exportCaptions(
  format: ExportFormat,
  captions: CaptionBlock[],
  baseName: string,
  fps: number,
  dropFrame = false,
): Promise<void> {
  const content = await runFormat(format.formatPath, serialize(captions), fps, dropFrame);

  const savePath = await save({
    title: "Export Captions",
    filters: [{ name: format.name, extensions: [format.extension] }],
    defaultPath: `${baseName}.${format.extension}`,
  });
  if (!savePath) return;

  await invoke<void>("save_project", { path: savePath, json: content });
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

  for (const item of items) {
    try {
      const content = await runFormat(format.formatPath, serialize(item.captions), item.fps, item.dropFrame);
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

  return { folder, written, failed };
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

async function runFormat(formatPath: string, captions: SerializedCaption[], fps: number, dropFrame: boolean): Promise<string> {
  const source = await invoke<string>("load_project", { path: formatPath });
  const config = parseCff(source);
  if (!config) throw new Error(`Invalid .cff format file: "${formatPath}"`);
  return executeTemplate(config.template, captions, fps, dropFrame);
}
