import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CONFIG_PATH = path.join(ROOT, "fvtt.config.js");

if (!existsSync(CONFIG_PATH)) {
  console.error(
    "Missing fvtt.config.js. Copy fvtt.config.example.js to fvtt.config.js and fill in your local paths.",
  );
  process.exit(1);
}

const { default: config } = await import(pathToFileURL(CONFIG_PATH).href);

if (!config.userDataPath || config.userDataPath === "/path/to/FoundryVTT") {
  console.error(
    "fvtt.config.js still has the placeholder userDataPath. Set it to your Foundry user data folder.",
  );
  process.exit(1);
}

export { config };
export const DATA_DIR = path.join(config.userDataPath, "Data");
export const CONTAINER_NAME = config.container;
