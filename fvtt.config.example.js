/**
 * Copy this file to fvtt.config.js (gitignored) and fill in your local paths.
 *
 * See ../../guide.md for the shared convention across sibling repos.
 */
export default {
  // Folder that CONTAINS Data/ (Foundry → Configure Settings → User Data Path).
  // macOS often: `${HOME}/Library/Application Support/FoundryVTT` or a custom `~/foundrydata`.
  userDataPath: "/path/to/FoundryVTT",

  // Cypress hits this (usually http://localhost:30000).
  baseURL: "http://localhost:30000",

  // World title on the Foundry setup screen — Cypress launches this for Quench e2e.
  testWorldName: "carl-rpg",

  // Optional Foundry admin password, used if /auth is shown.
  adminPassword: "",

  // Path to container_local_testing (for `npm run foundry:restart`).
  containerDir: "/path/to/container_local_testing",
  container: "foundry_13",
};
