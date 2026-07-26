#!/usr/bin/env bun
/**
 * build.ts — Reassemble CapyCanvas HTML from src/ (Data Canvas–style regions).
 *
 * Usage:
 *   bun build.ts                     # src/ → capycanvas.html
 *   bun build.ts -o out.html
 *   bun build.ts out.html            # shorthand for -o
 *   bun build.ts src out.html
 *   bun build.ts -s src -o out.html -t template.html
 */

import { readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";

const args = process.argv.slice(2);
let srcDir = "src";
let outPath = "capycanvas.html";
let templatePath = null;

const positionals = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-s" || a === "--src") srcDir = args[++i] || srcDir;
  else if (a === "-o" || a === "--out") outPath = args[++i] || outPath;
  else if (a === "-t" || a === "--template") templatePath = args[++i] || null;
  else if (a === "-h" || a === "--help") {
    console.log(`Usage:
  bun build.ts                     # rebuild capycanvas.html from src/
  bun build.ts -o out.html
  bun build.ts out.html            # same as -o out.html
  bun build.ts src out.html
  bun build.ts -s src -o out.html -t template.html`);
    process.exit(0);
  } else if (a.startsWith("-")) {
    console.error("Unknown flag:", a);
    process.exit(1);
  } else {
    positionals.push(a);
  }
}

if (positionals.length === 1) {
  if (positionals[0].endsWith(".html")) outPath = positionals[0];
  else srcDir = positionals[0];
} else if (positionals.length >= 2) {
  srcDir = positionals[0];
  outPath = positionals[1];
}

srcDir = resolve(srcDir);
outPath = resolve(outPath);

const manifestPath = join(srcDir, "manifest.json");
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (e) {
  console.error("Could not read", manifestPath);
  console.error("Run  bun split.ts  first.");
  process.exit(1);
}

// Prefer a local capycanvas.html as template when present; fall back to manifest.source
let tpl;
if (templatePath) {
  tpl = resolve(templatePath);
} else {
  try {
    await readFile(resolve("capycanvas.html"), "utf8");
    tpl = resolve("capycanvas.html");
  } catch {
    tpl = resolve(manifest.source || "capycanvas.html");
  }
}

let html;
try {
  html = await readFile(tpl, "utf8");
} catch (e) {
  console.error("Could not read template:", tpl);
  process.exit(1);
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeRe(rel, kind) {
  const e = esc(rel);
  if (kind === "html-comment") {
    return new RegExp(
      "(<!--\\s*#region\\s+file:\\s*" + e + "\\s*-->)\\s*[\\s\\S]*?\\s*(<!--\\s*#endregion\\s*-->)"
    );
  }
  if (kind === "css-comment") {
    return new RegExp(
      "(\\/\\*\\s*#region\\s+file:\\s*" + e + "\\s*\\*\\/)\\s*[\\s\\S]*?\\s*(\\/\\*\\s*#endregion\\s*\\*\\/)"
    );
  }
  if (kind === "js-comment") {
    return new RegExp(
      "(\\/\\/\\s*#region\\s+file:\\s*" + e + "[^\\n]*\\n)[\\s\\S]*?(\\/\\/\\s*#endregion\\b)"
    );
  }
  if (kind === "pyregion") {
    return new RegExp(
      "(#\\s*pyregion\\s+file:\\s*" + e + "[^\\n]*\\n)[\\s\\S]*?(?=</script>)"
    );
  }
  return null;
}

function applyReplace(html, re, kind, content) {
  if (kind === "html-comment" || kind === "css-comment") {
    return html.replace(re, "$1\n" + content + "\n$2");
  }
  if (kind === "js-comment") {
    return html.replace(re, "$1" + content + "\n$2");
  }
  if (kind === "pyregion") {
    return html.replace(re, "$1" + content + "\n");
  }
  return html;
}

let replaced = 0;
for (const { path: rel, kind } of manifest.regions) {
  let content;
  try {
    content = await readFile(join(srcDir, rel), "utf8");
    if (content.endsWith("\n")) content = content.slice(0, -1);
  } catch (e) {
    console.warn("  skip missing", rel);
    continue;
  }

  const re = makeRe(rel, kind);
  if (!re) {
    console.warn("  unknown kind", kind, "for", rel);
    continue;
  }

  // Test match without relying on string equality (content may be unchanged)
  if (!re.test(html)) {
    console.warn("  no match for", kind, "region", rel);
    continue;
  }
  // Reset lastIndex after test()
  re.lastIndex = 0;

  html = applyReplace(html, re, kind, content);
  replaced++;
  console.log("  injected", rel);
}

await writeFile(outPath, html, "utf8");
console.log("\nBuilt", outPath, " (" + replaced + "/" + manifest.regions.length + " regions replaced)");
if (replaced === 0) {
  console.warn("Warning: no regions were replaced. Check that the template still has #region markers.");
}
