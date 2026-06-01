#!/usr/bin/env node
// Fail-fast guard against U+FFFD replacement characters slipping into source.
// A bad copy-paste (e.g. through PowerShell, or an editor encoding mishap) can
// silently introduce 0xEF 0xBF 0xBD bytes that render as `�`. We hit this once
// in section-header comments; this check prevents the regression.
//
// Scans tracked text files under src/ and src-tauri/src/. Skips binaries
// (icons, sidecar binaries) because EF BF BD is a valid byte sequence in
// arbitrary binary content and would produce false positives.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const ROOTS = ["src", "src-tauri/src"];
const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".html", ".json", ".md", ".rs", ".toml",
]);

const BAD = Buffer.from([0xEF, 0xBF, 0xBD]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (st.isFile()) {
      const dot = name.lastIndexOf(".");
      if (dot >= 0 && TEXT_EXTS.has(name.slice(dot))) yield full;
    }
  }
}

const hits = [];
for (const root of ROOTS) {
  try {
    for (const file of walk(root)) {
      const buf = readFileSync(file);
      if (buf.includes(BAD)) hits.push(file.split(sep).join("/"));
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

if (hits.length) {
  console.error("✗ U+FFFD replacement chars found in:");
  for (const f of hits) console.error(`  ${f}`);
  console.error("\nReplace with the intended character (often U+2500 ─ for section dividers).");
  process.exit(1);
} else {
  console.log("✓ No U+FFFD replacement chars in src/ or src-tauri/src/");
}
