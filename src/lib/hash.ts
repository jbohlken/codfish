/** Hash a string with SHA-256. Normalizes line endings and trims trailing
 *  whitespace for cross-platform determinism. Returns lowercase hex. */
export async function hashContent(content: string): Promise<string> {
  const normalized = content.replace(/\r\n/g, "\n").trimEnd();
  const bytes = new TextEncoder().encode(normalized);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
