/**
 * The system's compendium ids, and unlocking one for a write.
 *
 * Pure (no Foundry globals at load): the Node PDF tool loads it through
 * module/pdf-import/compendium-match.mjs.
 */

/** The system's own compendiums (system.json "packs"), by role. */
export const PACKS = Object.freeze({
  skillsAndSpells: "carl-rpg.skills-and-spells",
  classesAndRaces: "carl-rpg.classes-and-races",
  rollTables: "carl-rpg.roll-tables",
  consumables: "carl-rpg.consumables",
  gear: "carl-rpg.gear",
});

/**
 * Run `fn` with a compendium unlocked (a GM may have locked it), then lock
 * it again if it was.
 * @template T
 * @param {CompendiumCollection} pack
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export async function withUnlockedPack(pack, fn) {
  const wasLocked = pack.locked;
  if (wasLocked) await pack.configure({ locked: false });
  try {
    return await fn();
  } finally {
    if (wasLocked) await pack.configure({ locked: true });
  }
}
