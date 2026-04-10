import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { CaptionBlock } from "../../types/project";
import { executeTemplate, parseCff } from "./builder";

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
  speaker: string | null;
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

/** Execute a format's template and prompt the user for a save path. */
export async function exportCaptions(
  format: ExportFormat,
  captions: CaptionBlock[],
  baseName: string,
): Promise<void> {
  const serialized: SerializedCaption[] = captions.map((c) => ({
    index: c.index,
    start: c.start,
    end: c.end,
    lines: c.lines,
    speaker: c.speaker ?? null,
  }));

  const content = await runFormat(format.formatPath, serialized);

  const savePath = await save({
    title: "Export Captions",
    filters: [{ name: format.name, extensions: [format.extension] }],
    defaultPath: `${baseName}.${format.extension}`,
  });
  if (!savePath) return;

  await invoke<void>("save_project", { path: savePath, json: content });
}

/** Return (and create) the user's export_formats directory path. */
export async function getFormatsDir(): Promise<string> {
  return invoke<string>("get_export_formats_dir");
}

/** Open the export_formats directory in the system file manager. */
export async function openFormatsDir(): Promise<void> {
  const dir = await getFormatsDir();
  await invoke<void>("open_in_explorer", { path: dir });
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

// ── Format execution ────────────────────────────────────────────────────────

async function runFormat(formatPath: string, captions: SerializedCaption[]): Promise<string> {
  const source = await invoke<string>("load_project", { path: formatPath });
  const config = parseCff(source);
  if (!config) throw new Error(`Invalid .cff format file: "${formatPath}"`);
  return executeTemplate(config.template, captions);
}
