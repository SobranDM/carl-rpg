/**
 * Compiles packs-source/<pack>/*.json (hand-authored Item source documents)
 * into the LevelDB compendium packs declared in system.json's `packs` array,
 * using the standard modern Foundry workflow (@foundryvtt/foundryvtt-cli).
 *
 * Usage: npm run build:packs
 */
import { compilePack } from "@foundryvtt/foundryvtt-cli";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const SRC_ROOT = path.join(ROOT, "packs-source");
const DEST_ROOT = path.join(ROOT, "packs");

const packNames = fs.readdirSync(SRC_ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

for (const name of packNames) {
  const src = path.join(SRC_ROOT, name);
  const dest = path.join(DEST_ROOT, name);
  console.log(`Compiling pack "${name}" (${src} -> ${dest})`);
  await compilePack(src, dest, { log: true });
}

console.log(`Done. Compiled ${packNames.length} pack(s): ${packNames.join(", ")}`);
