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

/** The fields a copy of a document doesn't take: it gets its own. */
const COPY_DROPS = ["_id", "folder", "sort", "ownership"];

/**
 * Drop what a copy doesn't take (its id, folder, sort and ownership) from
 * plain document data, in place.
 * @param {object} data
 * @returns {object}  The same data.
 */
export function stripCopyFields(data) {
  for (const key of COPY_DROPS) delete data[key];
  return data;
}

/**
 * A document's data as a new copy (a compendium item onto an actor or into
 * the world): no id, folder, sort or ownership of its own, and where it came
 * from kept as Foundry's `_stats.compendiumSource` (ruled 2026-11-19), so a
 * later refresh can find copies by source rather than by name.
 * @param {foundry.abstract.Document} doc
 * @returns {object}
 */
export function copyData(doc) {
  const data = stripCopyFields(doc.toObject());
  data._stats = { compendiumSource: doc.uuid };
  return data;
}
