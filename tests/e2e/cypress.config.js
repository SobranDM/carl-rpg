import { defineConfig } from "cypress";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { applyChromeLaunchArgs } from "./cypress/chrome-launch-args.js";

let fvttConfig;
try {
  const configPath = path.resolve(import.meta.dirname, "..", "..", "fvtt.config.js");
  ({ default: fvttConfig } = await import(pathToFileURL(configPath).href));
} catch {
  fvttConfig = undefined;
}

const baseUrl = process.env.FOUNDRY_BASE_URL || fvttConfig?.baseURL || "http://localhost:30000";
const adminPassword =
  process.env.FOUNDRY_ADMIN_KEY || process.env.FOUNDRY_PASSWORD || fvttConfig?.adminPassword || "";
const foundryWorld = process.env.FOUNDRY_WORLD || fvttConfig?.testWorldName || "carl-rpg";

const isCiRun = process.env.CI === "true" || process.env.CYPRESS_CI === "1";

export default defineConfig({
  e2e: {
    baseUrl,
    ...(isCiRun
      ? {
          video: false,
          screenshotOnRunFailure: true,
          defaultCommandTimeout: 120000,
          requestTimeout: 15000,
          responseTimeout: 15000,
          pageLoadTimeout: 60000,
          retries: { runMode: 2, openMode: 0 },
        }
      : {}),
    setupNodeEvents(on, config) {
      on("before:browser:launch", (browser, launchOptions) => {
        if (browser.name === "chrome" || browser.name === "chromium") {
          applyChromeLaunchArgs(launchOptions);
        }
        return launchOptions;
      });
      return config;
    },
  },
  env: {
    ADMIN_PASSWORD: adminPassword,
    FOUNDRY_WORLD: foundryWorld,
  },
  viewportWidth: 1366,
  viewportHeight: 768,
});
