#!/usr/bin/env node
/**
 * Collect license texts for all production npm dependencies.
 * Writes a single THIRD_PARTY_LICENSES.txt file.
 *
 * Usage:
 *   npx license-checker-rspack --production --plainVertical --out THIRD_PARTY_LICENSES_NPM.txt
 *
 * This script is a thin wrapper that adds a header and runs the tool.
 */

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const outPath = process.argv[2] || resolve("THIRD_PARTY_LICENSES_NPM.txt");
const tmpPath = outPath + ".tmp";

try {
  execSync(
    `npx license-checker-rspack --production --plainVertical --out "${tmpPath}"`,
    { stdio: ["pipe", "pipe", "inherit"] },
  );
} catch (e) {
  console.error("license-checker-rspack failed:", e.message);
  process.exit(1);
}

const body = readFileSync(tmpPath, "utf-8");
const header =
  "THIRD-PARTY SOFTWARE LICENSES\n" +
  "=============================\n" +
  "\n" +
  "The Codfish frontend bundles the following npm packages.\n" +
  "Each package's license text is reproduced below.\n" +
  "\n" +
  "=".repeat(72) + "\n\n";

writeFileSync(outPath, header + body, "utf-8");
try { unlinkSync(tmpPath); } catch {}
console.log(`Wrote ${outPath}`);
