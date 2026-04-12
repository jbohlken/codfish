/**
 * Pure helpers for validating and normalizing export format configs.
 * Extracted from FormatManager.tsx so they can be unit-tested without
 * spinning up the component.
 */

import type { FormatConfig } from "./builder";
import type { ExportFormat } from "./index";

export interface FieldErrors {
  name?: string;
  extension?: string;
  template?: string;
}

/**
 * Validate a format config against the list of existing formats.
 *
 * @param currentFormatPath The formatPath of the format currently being
 *   edited; excluded from the duplicate-name check so editing a format
 *   doesn't flag itself.
 */
export function validateFormatConfig(
  config: FormatConfig,
  formats: ExportFormat[],
  currentFormatPath: string | null,
): FieldErrors {
  const errs: FieldErrors = {};
  if (!config.name.trim()) {
    errs.name = "Required";
  } else {
    const duplicate = formats.find(
      (f) => f.name === config.name.trim() && f.formatPath !== currentFormatPath,
    );
    if (duplicate) errs.name = "Name in use";
  }
  if (!config.extension.trim()) errs.extension = "Required";
  if (!config.template.trim()) errs.template = "Required";
  return errs;
}

/**
 * Trim name and extension so the on-disk state matches what the Rust parser
 * will hand back on the next list_user_formats call. Template whitespace is
 * preserved — it's meaningful content.
 */
export function normalizeFormatConfig(config: FormatConfig): FormatConfig {
  return {
    name: config.name.trim(),
    extension: config.extension.trim(),
    template: config.template,
  };
}

/**
 * Generate a unique display name by appending " 2", " 3", ... if `base`
 * collides with an existing format name.
 */
export function uniqueFormatName(base: string, formats: ExportFormat[]): string {
  const names = new Set(formats.map((f) => f.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!names.has(candidate)) return candidate;
  }
}

/**
 * Generate a .cff filename that doesn't collide with any existing format file.
 * Retries until `generate()` produces a unique name.
 *
 * @param generate Injection point for the random-name source. Default uses
 *   crypto.randomUUID. Override in tests for determinism.
 */
export function randomFormatFilename(
  formats: ExportFormat[],
  generate: () => string = () => `user-${crypto.randomUUID().slice(0, 8)}.cff`,
): string {
  const filenames = new Set(
    formats.map((f) => f.formatPath.replace(/\\/g, "/").split("/").pop()),
  );
  let name: string;
  do {
    name = generate();
  } while (filenames.has(name));
  return name;
}
