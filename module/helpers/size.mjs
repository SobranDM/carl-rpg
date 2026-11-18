/**
 * Size as text - a Race's "Medium (4)", the old Pet tab's free-text Size -
 * read as a size value (CONFIG.CARLRPG.sizes, 1-8). The reading itself is
 * helpers/size-text.mjs (no Foundry globals, for the PDF parsers); this adds
 * the localized size names.
 */
import { parseSizeText } from "./size-text.mjs";

/**
 * A size value from text: a number ("5"), a size name ("Large", "huge"), or
 * both ("Large (5)", "Medium (4), mostly due to wings"). null if it's
 * neither (a Doppelganger's "Unchanged, but size changes when shifting").
 * @param {string} text
 * @returns {number|null}
 */
export function parseSize(text) {
  const localized = Object.fromEntries(
    Object.entries(CONFIG.CARLRPG.sizes).map(([value, key]) => [value, [game.i18n.localize(key)]]),
  );
  return parseSizeText(text, localized);
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
