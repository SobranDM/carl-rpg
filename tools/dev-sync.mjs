/**
 * Copies the runtime parts of the system into the Foundry user data folder
 * from fvtt.config.js (Data/systems/carl-rpg), so a running Foundry picks up
 * local edits after a world reload. Mirrors the release zip whitelist in
 * .github/workflows/release.yml, plus module/quench for the dev test batches.
 *
 * Usage: npm run dev:sync   (run build + build:packs first, or use npm run dev)
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./lib/fvtt-config.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TARGET = path.join(DATA_DIR, "systems", "carl-rpg");

const ENTRIES_TO_SYNC = [
  "system.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE.txt",
  "module",
  "templates",
  "css",
  "lang",
  "assets",
  "packs",
];

await mkdir(TARGET, { recursive: true });

for (const entry of ENTRIES_TO_SYNC) {
  const source = path.join(ROOT, entry);
  if (!existsSync(source)) continue;
  const dest = path.join(TARGET, entry);
  // Packs are LevelDB folders; replace them whole so stale .ldb files don't linger.
  if (entry === "packs") await rm(dest, { recursive: true, force: true });
  await cp(source, dest, { recursive: true, force: true });
  console.log(`Synced ${entry} -> ${TARGET}`);
}

console.log(`\nSystem deployed to ${TARGET}`);
console.log("Reload the world (or restart Foundry if packs changed while it held them open).");
