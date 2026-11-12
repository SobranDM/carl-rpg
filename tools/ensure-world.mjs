/**
 * Creates the local test world named in fvtt.config.js (testWorldName) under
 * Data/worlds/, if it doesn't exist yet. Quench still has to be enabled in the
 * world once by hand (Manage Modules) — Foundry keeps that in the world DB.
 *
 * Usage: npm run dev:world
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, DATA_DIR } from "./lib/fvtt-config.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const system = JSON.parse(await readFile(path.join(ROOT, "system.json"), "utf8"));

const WORLD_ID = (config.testWorldName || "carl-rpg").toLowerCase().replace(/[^a-z0-9]+/g, "-");
const WORLD_DIR = path.join(DATA_DIR, "worlds", WORLD_ID);
const WORLD_JSON_PATH = path.join(WORLD_DIR, "world.json");

if (existsSync(WORLD_JSON_PATH)) {
  console.log(`World already exists at ${WORLD_JSON_PATH}`);
  process.exit(0);
}

await mkdir(path.join(WORLD_DIR, "data"), { recursive: true });

const worldJson = {
  title: config.testWorldName || "carl-rpg",
  id: WORLD_ID,
  system: system.id,
  coreVersion: String(system.compatibility.minimum),
  compatibility: {
    minimum: String(system.compatibility.minimum),
    verified: String(system.compatibility.verified),
  },
  systemVersion: system.version,
  description: "Local dev world for the carl-rpg system.",
  flags: {},
};

await writeFile(WORLD_JSON_PATH, JSON.stringify(worldJson, null, 2));
console.log(`Created dev world at ${WORLD_JSON_PATH}`);
console.log("Launch it from /setup, then enable the Quench module in Manage Modules once.");
