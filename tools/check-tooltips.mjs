/**
 * The system's tooltips are Foundry's (`data-tooltip`, `data-tooltip-text`,
 * `data-tooltip-html` - TooltipManager), never the browser's `title`
 * attribute. This lists every HTML `title="` in the templates and in markup
 * built in module/ (Handlebars hash arguments like `{{localize k title=x}}`
 * aren't attributes and are skipped), and exits 1 if there are any.
 *
 *   npm run check:tooltips
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function* files(dir, ext) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "vendor" || entry.name === "node_modules") continue;
      yield* files(full, ext);
    } else if (entry.name.endsWith(ext)) {
      yield full;
    }
  }
}

/** Offsets of `title="` attributes outside {{ }}: preceded by whitespace or "}}". */
function titleAttributes(text) {
  const found = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith("{{", i)) { depth++; i++; continue; }
    if (depth && text.startsWith("}}", i)) { depth--; i++; continue; }
    if (!depth && (text.startsWith('title="', i) || text.startsWith("title='", i)) && i > 0 && /[\s}]/.test(text[i - 1])) found.push(i);
  }
  return found;
}

const problems = [];
for (const file of files(path.join(ROOT, "templates"), ".hbs")) {
  const text = fs.readFileSync(file, "utf8");
  for (const at of titleAttributes(text)) problems.push([file, text.slice(0, at).split("\n").length]);
}
// Markup built in code: a `title="` inside a string or template literal.
for (const file of files(path.join(ROOT, "module"), ".mjs")) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/<[a-z][^>]*\stitle=["'$]/i.test(line) || /\.setAttribute\(\s*["']title["']/.test(line) || /\.title\s*=\s*[^=]/.test(line) && /\b(el|element|button|span|div|a|img|li|node)\.title\b/.test(line)) {
      problems.push([file, i + 1]);
    }
  });
}

if (problems.length) {
  console.log("Browser title= tooltips found - use data-tooltip / data-tooltip-text / data-tooltip-html:");
  for (const [file, line] of problems) console.log(`  ${path.relative(ROOT, file)}:${line}`);
  process.exit(1);
}
console.log("Tooltips: all Foundry (no title= attributes).");
