/**
 * Preview what the in-Foundry PDF importer would pull out of a rulebook,
 * without Foundry. Runs the same parsers (module/pdf-import/) over the
 * user's own copy of a book and writes one JSON file per document.
 *
 * The books are copyrighted and this repo is public, so the output goes to a
 * gitignored folder (pdf_local/<book>/ by default) and is never committed.
 *
 * Usage:
 *   node tools/pdf-import/extract-rulebook.mjs <rulebook.pdf> [outDir]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  bookTitleFromFilename,
  parseBook,
  readPages,
  slugify,
} from "../../module/pdf-import/scan.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// pdf.js calls Math.sumPrecise, which Node may lack.
Math.sumPrecise ??= (values) => {
  let sum = 0;
  for (const value of values) sum += value;
  return sum;
};

async function main() {
  const [pdf, outArg] = process.argv.slice(2);
  if (!pdf || !fs.existsSync(pdf)) {
    console.error("Usage: node tools/pdf-import/extract-rulebook.mjs <rulebook.pdf> [outDir]");
    process.exit(1);
  }
  const book = bookTitleFromFilename(path.basename(pdf));
  const outDir = path.resolve(outArg ?? path.join(ROOT, "pdf_local", slugify(book)));

  const pdfjs = await import("../../module/vendor/pdfjs/pdf.mjs");
  const pdfDoc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(pdf)),
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  const found = parseBook(await readPages(pdfDoc));

  for (const [kind, docs] of Object.entries(found)) {
    if (kind === "maps") continue;
    const dir = path.join(outDir, kind);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const doc of docs) {
      const file = path.join(dir, `p${String(doc.page).padStart(3, "0")}-${slugify(doc.name)}.json`);
      fs.writeFileSync(file, JSON.stringify(doc.data, null, 2) + "\n");
    }
    console.log(`${kind}: ${docs.length}`);
  }
  console.log(`maps (candidate pages): ${found.maps.length}`);
  for (const map of found.maps)
    console.log(`  p${map.page} ${map.likely ? "[x]" : "[ ]"} ${map.name}`);
  console.log(`Wrote ${outDir}`);
}

await main();
