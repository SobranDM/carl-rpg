import { withUnlockedPack } from "./packs.mjs";
import { queueOn } from "./actor-queue.mjs";

/**
 * The Achievements library (ruled 2026-11-19): a world compendium the
 * system makes and keeps - the GM never opens it. Achievements are made,
 * edited and deleted in the Achievements window (apps/achievement-grid.mjs),
 * and the rulebook import writes there too, a folder per book. Players
 * can't see it (the "Contents" notes are spoilers).
 *
 * Writes go one at a time: each unlocks the compendium if the GM locked it,
 * and puts the lock back after.
 */

const SCOPE = "carl-rpg";
const FLAG = "achievementLibrary";
const NAME = "carl-achievements";
const queues = new Map();

/**
 * The library, if it has been made: found by its flag (the GM may rename
 * it), else by its name.
 * @returns {CompendiumCollection|null}
 */
export function achievementLibrary() {
  const world = game.packs.filter(
    (p) => p.metadata.packageType === "world" && p.documentName === "Item",
  );
  return (
    world.find((p) => p.metadata.flags?.[SCOPE]?.[FLAG]) ??
    world.find((p) => p.metadata.name === NAME) ??
    null
  );
}

/**
 * The library, made if it's missing (GM).
 * @returns {Promise<CompendiumCollection|null>}
 */
export function ensureAchievementLibrary() {
  return queueOn(queues, "make", async () => {
    const found = achievementLibrary();
    if (found || !game.user.isGM) return found;
    return foundry.documents.collections.CompendiumCollection.createCompendium({
      type: "Item",
      name: NAME,
      label: game.i18n.localize("CARLRPG.Achievement.Library"),
      flags: { [SCOPE]: { [FLAG]: true } },
      ownership: { PLAYER: "NONE", TRUSTED: "NONE", ASSISTANT: "OWNER" },
    });
  });
}

/**
 * Every achievement in the library.
 * @returns {Promise<Item[]>}
 */
export async function libraryAchievements() {
  const pack = achievementLibrary();
  return pack ? pack.getDocuments({ type: "achievement" }) : [];
}

/**
 * Is this achievement one of the library's?
 * @param {Item} item
 * @returns {boolean}
 */
export function inLibrary(item) {
  const pack = achievementLibrary();
  return !!pack && item?.pack === pack.collection;
}

/** Run a write on the library, one at a time, unlocked for it. */
function write(fn) {
  return queueOn(queues, "write", async () => {
    const pack = await ensureAchievementLibrary();
    if (!pack) return null;
    return withUnlockedPack(pack, () => fn(pack));
  });
}

/**
 * A new achievement in the library (GM).
 * @param {object} [data]  Item data; name and type are filled in.
 * @returns {Promise<Item|null>}
 */
export function createLibraryAchievement(data = {}) {
  return write((pack) =>
    Item.implementation.create(
      { name: game.i18n.localize("CARLRPG.Achievement.NewName"), ...data, type: "achievement" },
      { pack: pack.collection },
    ),
  );
}

/**
 * Change a library achievement (GM).
 * @param {Item} achievement
 * @param {object} changes
 * @returns {Promise<Item|null>}
 */
export function updateLibraryAchievement(achievement, changes) {
  return write(() => achievement.update(changes));
}

/**
 * Delete a library achievement (GM). Crawlers who were awarded it keep
 * their copy.
 * @param {Item} achievement
 * @returns {Promise<Item|null>}
 */
export function deleteLibraryAchievement(achievement) {
  return write(() => achievement.delete());
}
