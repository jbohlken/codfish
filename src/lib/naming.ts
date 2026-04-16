/**
 * Shared name/extension validation helpers used by ProfileManager and
 * FormatManager. Unifies error messages and character rules across managers.
 */

// Windows-reserved + control chars. Names aren't used as filenames directly
// (both managers use random UUIDs on disk), but these still cause the worst
// UX issues: copy/paste breakage, confusing display, .cod portability across OSes.
const INVALID_NAME_CHARS = /[/\\:*?"<>|\x00-\x1f]/;
const INVALID_EXTENSION_CHARS = /[^a-zA-Z0-9]/;

/** Returns an error message if the name is empty or contains invalid chars. */
export function validateNameChars(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Required";
  if (INVALID_NAME_CHARS.test(trimmed)) return "Invalid characters";
  return null;
}

/** Returns an error message if the extension is empty or non-alphanumeric. */
export function validateExtensionChars(ext: string): string | null {
  const trimmed = ext.trim();
  if (!trimmed) return "Required";
  if (INVALID_EXTENSION_CHARS.test(trimmed)) return "Letters and digits only";
  return null;
}
