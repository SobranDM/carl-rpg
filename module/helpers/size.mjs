/**
 * Size as text - a Race's "Medium (4)", the old Pet tab's free-text Size -
 * read as a size value (CONFIG.CARLRPG.sizes, 1-8).
 */

/**
 * A size value from text: a number ("5"), a size name ("Large", "huge"), or
 * both ("Large (5)", "Medium (4), mostly due to wings"). null if it's
 * neither (a Doppelganger's "Unchanged, but size changes when shifting").
 * @param {string} text
 * @returns {number|null}
 */
export function parseSize(text) {
  if (text === null || text === undefined || !String(text).trim()) return null;
  const s = String(text).trim();
  const number = s.match(/\d+/);
  if (number) {
    const n = Number(number[0]);
    if (CONFIG.CARLRPG.sizes[n]) return n;
  }
  const words = s.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const word of words) {
    for (const [value, key] of Object.entries(CONFIG.CARLRPG.sizes)) {
      const names = [String(key).split(".").pop().toLowerCase(), game.i18n.localize(key).toLowerCase()];
      if (names.includes(word)) return Number(value);
    }
  }
  return null;
}

/**
 * When a Race is added to a Character, its Size becomes the Character's
 * (Race & Class Selection - each Race lists a Size). Only then, so a GM's
 * later change sticks; a Race whose Size isn't one ("Unchanged") leaves it.
 * @param {Item} race  A race item just created on an actor.
 * @returns {Promise<number|null>}  The Size set, or null.
 */
export async function applyRaceSize(race) {
  const actor = race?.parent;
  if (race?.type !== "race" || actor?.type !== "character") return null;
  const size = parseSize(race.system.size);
  if (size === null || size === actor.system.details.size) return null;
  await actor.update({ "system.details.size": size });
  return size;
}
