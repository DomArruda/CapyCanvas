#!/usr/bin/env bun
/**
 * split.ts — Extract #region / #endregion / pyregion blocks from a single-file
 * CapyCanvas (or Data Canvas style) HTML into a modular src/ tree.
 *
 * Usage:
 *   bun run split.ts [input.html] [outDir]
 *
 * Defaults:
 *   input.html = capycanvas.html
 *   outDir     = src
 *
 * Supported region markers (same conventions as Data Canvas):
 *   <!-- #region file: path/to/file.ext --> ... <!-- #endregion -->
 *   /* #region file: path/to/file.ext *\/ ... /* #endregion *\/
 *   //#region file: path/to/file.ext ... //#endregion
 *   # pyregion file: path/to/file.py   (inside a <script type="text/x-python">)
 *
 * The original HTML is left intact. Extracted files are written relative to outDir.
 * A manifest.json is also written so build.ts can reassemble in order.
 */

import { mkdir, writeFile, readFile } from "fs/promises";
import { dirname, join, resolve } from "path";

const inputPath = resolve(process.argv[2] || "capycanvas.html");
const outDir = resolve(process.argv[3] || "src");

const html = await readFile(inputPath, "utf8");

type Region = {
  path: string;
  content: string;
  kind: "html-comment" | "css-comment" | "js-comment" | "pyregion";
  start: number;
  end: number;
};

const regions: Region[] = [];

// 1. HTML comment regions: <!-- #region file: X --> ... <!-- #endregion -->
{
  const re =
    /<!--\s*#region\s+file:\s*([^\s]+)\s*-->([\s\S]*?)<!--\s*#endregion\s*-->/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    regions.push({
      path: m[1].trim(),
      content: m[2].replace(/^\n/, "").replace(/\n$/, ""),
      kind: "html-comment",
      start: m.index,
      end: m.index + m[0].length,
    });
  }
}

// 2. CSS comment regions: /* #region file: X */ ... /* #endregion */
{
  const re =
    /\/\*\s*#region\s+file:\s*([^\s*]+)\s*\*\/([\s\S]*?)\/\*\s*#endregion\s*\*\//g;
  let m;
  while ((m = re.exec(html)) !== null) {
    regions.push({
      path: m[1].trim(),
      content: m[2].replace(/^\n/, "").replace(/\n$/, ""),
      kind: "css-comment",
      start: m.index,
      end: m.index + m[0].length,
    });
  }
}

// 3. JS line-comment regions: //#region file: X ... //#endregion
{
  const re =
    /\/\/\s*#region\s+file:\s*([^\s]+)[^\n]*\n([\s\S]*?)\/\/\s*#endregion\s*(?:\n|$)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    regions.push({
      path: m[1].trim(),
      content: m[2].replace(/^\n/, "").replace(/\n$/, ""),
      kind: "js-comment",
      start: m.index,
      end: m.index + m[0].length,
    });
  }
}

// 4. Python pyregion (inside a script block): # pyregion file: X
//    We capture from the pyregion line until the closing </script>
{
  const re =
    /#\s*pyregion\s+file:\s*([^\s\n]+)[^\n]*\n([\s\S]*?)(?=<\/script>)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    regions.push({
      path: m[1].trim(),
      content: m[2].replace(/^\n/, "").replace(/\n$/, ""),
      kind: "pyregion",
      start: m.index,
      end: m.index + m[0].length,
    });
  }
}

// Sort by appearance order in the source
regions.sort((a, b) => a.start - b.start);

if (regions.length === 0) {
  console.error("No regions found. Make sure the HTML contains #region / pyregion markers.");
  process.exit(1);
}

const manifest: { path: string; kind: string }[] = [];

for (const r of regions) {
  const dest = join(outDir, r.path);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, r.content + "\n", "utf8");
  manifest.push({ path: r.path, kind: r.kind });
  console.log(`  wrote ${r.path}  (${r.kind}, ${r.content.length} chars)`);
}

await mkdir(outDir, { recursive: true });
await writeFile(
  join(outDir, "manifest.json"),
  JSON.stringify({ source: "capycanvas.html", regions: manifest }, null, 2) + "\n",
  "utf8"
);

console.log(`\nSplit ${regions.length} region(s) into ${outDir}/`);
console.log(`Manifest: ${join(outDir, "manifest.json")}`);
