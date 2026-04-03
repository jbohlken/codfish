import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { CaptionBlock } from "../../types/project";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExportFormat {
  id: string;        // absolute path to the .js file
  name: string;
  extension: string;
  scriptPath: string;
}

/** The shape passed into every transform(captions) call. */
export interface SerializedCaption {
  index: number;
  start: number;    // seconds
  end: number;      // seconds
  lines: string[];
  speaker: string | null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Return all .js files from the user's export_formats directory. */
export async function listFormats(): Promise<ExportFormat[]> {
  try {
    const meta = await invoke<Array<{ name: string; extension: string; path: string }>>(
      "list_user_formats",
    );
    return meta.map((f) => ({
      id: f.path,
      name: f.name,
      extension: f.extension,
      scriptPath: f.path,
    }));
  } catch {
    return [];
  }
}

/** Run the format's transform script and prompt the user for a save path. */
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

  const content = await runScript(format.scriptPath, serialized);

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

// ── Script runner ─────────────────────────────────────────────────────────────

async function runScript(scriptPath: string, captions: SerializedCaption[]): Promise<string> {
  const source = await invoke<string>("load_project", { path: scriptPath });
  try {
    // eslint-disable-next-line no-new-func
    const transform = new Function(`${source}\nreturn transform;`)() as (
      c: SerializedCaption[],
    ) => string;
    return transform(captions);
  } catch (e) {
    throw new Error(`Export script error in "${scriptPath}": ${e}`);
  }
}
