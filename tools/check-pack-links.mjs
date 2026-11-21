/**
 * Every link inside the system's compendium sources must resolve: a
 * `documentUuid` ("Compendium.carl-rpg.<pack>.<Type>.<id>") in a Roll Table
 * result, and a compendium uuid named in an item (a Scroll's Spell), must
 * name a document in packs-source/<pack>. The pack build doesn't check this.
 *
 *   npm run check:packs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packs-source");
const ids = new Map();
const docs = [];
for (const pack of fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  const set = new Set();
  for (const file of fs
    .readdirSync(path.join(ROOT, pack.name))
    .filter((f) => f.endsWith(".json"))) {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, pack.name, file), "utf8"));
    set.add(doc._id);
    docs.push({ pack: pack.name, file, doc });
  }
  ids.set(pack.name, set);
}

const LINK = /Compendium\.carl-rpg\.([\w-]+)\.\w+\.([A-Za-z0-9]{16})/g;
const problems = [];
for (const { pack, file, doc } of docs) {
  for (const [, target, id] of JSON.stringify(doc).matchAll(LINK)) {
    if (!ids.get(target)?.has(id))
      problems.push(`${pack}/${file}: Compendium.carl-rpg.${target}…${id}`);
  }
}

if (problems.length) {
  console.log("Links to documents that aren't in packs-source:");
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log(`Pack links: all resolve (${docs.length} documents).`);
