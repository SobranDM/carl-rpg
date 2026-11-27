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
 * A Roll Table a GM may replace with their own, by name: the world's own
 * first, then the world's compendiums (the first one the world lists - the
 * order they were made, not the sidebar's), then the system's Roll Tables
 * pack. Used for loot box contents (loot.mjs boxTable, ruled 2026-11-20)
 * and character creation's tables (chargen.mjs chargenTable, ruled
 * 2026-11-27). Only compendiums this user can see: a player opening the
 * Crawler Creation wizard never reaches a GM's private one, and one that
 * can't be read is passed over.
 * @param {string} name
 * @returns {Promise<RollTable|null>}
 */
export async function overridableTable(name) {
  const world = game.tables?.getName?.(name);
  if (world) return world;
  const worldPacks = game.packs.filter(
    (p) => p.documentName === "RollTable" && p.metadata.packageType === "world" && p.visible,
  );
  for (const pack of worldPacks) {
    try {
      const entry = (await pack.getIndex())?.find((e) => e.name === name);
      if (entry) return await pack.getDocument(entry._id);
    } catch (err) {
      console.warn(`CarlRPG | Couldn't read Roll Table compendium ${pack.collection}`, err);
      if (game.user?.isGM)
        ui.notifications?.warn(
          game.i18n.format("CARLRPG.Tables.Unreadable", { pack: pack.title, name }),
        );
    }
  }
  return systemTable(name);
}

/**
 * A Roll Table from the system's Roll Tables pack, by name - or the world's
 * own of that name, which a GM's edits go into (loot.mjs lootTable).
 * @param {string} name
 * @param {{world?: boolean}} [options]  world: look in the world first.
 * @returns {Promise<RollTable|null>}
 */
export async function systemTable(name, { world = false } = {}) {
  const own = world ? game.tables?.getName?.(name) : null;
  if (own) return own;
  const pack = game.packs.get(PACKS.rollTables);
  const entry = (await pack?.getIndex())?.find((e) => e.name === name);
  return entry ? pack.getDocument(entry._id) : null;
}

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
