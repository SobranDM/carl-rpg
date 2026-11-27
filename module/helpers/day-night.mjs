/**
 * Day and night (ruled 2026-11-27). The book gives no hours for a dungeon
 * day's halves, and floors differ (p.69), so it's never worked out from the
 * clock: the GM sets it with the sun/moon toggle in the GM Toolbox, a world
 * setting every client reads. What turns on it:
 *  - Lajabless (Races, p.136): by day +5 Int and the whole Strength halved;
 *    by night +5 Strength, then the whole Strength doubled. Spells cost half
 *    the Mana by day and double by night, after the Favored-Class +1,
 *    rounded up (never below 1) - helpers/mana-cost.mjs.
 *  - Night Elf (Races, p.134): Advantage on Hide in Shadows at night.
 *  - Gobblin' Hogs (Mob, Night Hunter): their Int and Dex Mods swap at
 *    night, which swaps their Surprise and Evade with them.
 * Keyed off the Race item's (or Mob's) name - or a `raceMechanic` flag for
 * a renamed copy ("lajabless" / "nightElf" on the Race item, "gobblinHog"
 * on the Mob) - so the generic Race item carries nothing for it.
 */
import { slugifySkillName } from "./modifiers.mjs";
import { unlinkedTokenActors } from "./token-resolution.mjs";

/** The world setting: "day" or "night". */
export const TIME_OF_DAY = "timeOfDay";

/** Whether it's night (the GM's toggle). Day if the setting isn't there yet. */
export function isNight() {
  try {
    return game.settings.get("carl-rpg", TIME_OF_DAY) === "night";
  } catch {
    return false;
  }
}

/**
 * A name as compared here: its slug, without a "(Primal)" ("Elf (Night)
 * (Primal)" -> "elf-night").
 */
function nameKey(name) {
  return slugifySkillName(String(name ?? "").replace(/\((?:primal)\)/gi, " "));
}

const RACE_KEYS = {
  lajabless: "lajabless",
  "elf-night": "nightElf",
  "night-elf": "nightElf",
};

/**
 * Which day/night Race a creature is, from its active Race item.
 * @param {object} sys  An Actor's system data (raceItem set in prepareDerivedData).
 * @returns {"lajabless"|"nightElf"|null}
 */
export function dayNightRace(sys) {
  const race = sys?.raceItem;
  if (!race) return null;
  const flagged = race.flags?.["carl-rpg"]?.raceMechanic;
  if (flagged) return flagged;
  return RACE_KEYS[nameKey(race.name)] ?? null;
}

/**
 * A Stat's total (base + every bonus, before any cap) as day or night makes
 * it for a Lajabless.
 * @param {object} sys
 * @param {string} key  The Stat.
 * @param {number} total
 * @returns {number}
 */
export function dayNightStat(sys, key, total) {
  if (dayNightRace(sys) !== "lajabless") return total;
  if (isNight()) return key === "str" ? (total + 5) * 2 : total;
  if (key === "int") return total + 5;
  if (key === "str") return total / 2;
  return total;
}

/**
 * A Spell's Mana cost by day or night for a Lajabless: half or double,
 * rounded up, at least 1 (a cost of 0 stays 0).
 * @param {Actor} actor
 * @param {number} cost  After the Favored-Class +1.
 * @returns {number}
 */
export function dayNightManaCost(actor, cost) {
  if (!cost || dayNightRace(actor?.system) !== "lajabless") return cost;
  return Math.max(1, Math.ceil(isNight() ? cost * 2 : cost / 2));
}

/**
 * Whether a Skill Check is made with Advantage for the time of day: a Night
 * Elf's Hide in Shadows at night.
 * @param {Actor} actor
 * @param {Item} skillItem
 * @returns {boolean}
 */
export function dayNightAdvantage(actor, skillItem) {
  return (
    isNight() &&
    dayNightRace(actor?.system) === "nightElf" &&
    slugifySkillName(skillItem?.name) === slugifySkillName("Hide in Shadows")
  );
}

/**
 * Set day or night (GM).
 * @param {"day"|"night"} value
 */
export function setTimeOfDay(value) {
  if (!game.user.isGM) return null;
  return game.settings.set("carl-rpg", TIME_OF_DAY, value === "night" ? "night" : "day");
}

/**
 * Bring a Lajabless's Mana above its Max back down to it (ruled 2026-11-27:
 * it loses its +5 Int at nightfall, and its Max Mana with it). Only a
 * Lajabless: anyone else's Mana can sit above Max on purpose (a potion's
 * overflow is kept). Run by the active GM once day or night has changed.
 * @returns {Promise<Actor[]>}  The actors brought down.
 */
export async function clampManaToMax() {
  // Unlinked tokens too: each has its own Mana (as the setting's reset).
  const over = [...game.actors, ...unlinkedTokenActors()].filter((actor) => {
    const mana = actor.system?.mana;
    return dayNightRace(actor.system) === "lajabless" && mana && mana.value > mana.max;
  });
  for (const actor of over) await actor.update({ "system.mana.value": actor.system.mana.max });
  return over;
}

/**
 * A Gobblin' Hog's Int and Dex Mods swap at night (its Night Hunter note),
 * so its Surprise and Evade swap with them. Run after its Stats are worked
 * out.
 * @param {object} sys  A Mob's system data.
 */
export function dayNightMobStats(sys) {
  if (!isNight()) return;
  const mob = sys?.parent;
  const flagged = mob?.flags?.["carl-rpg"]?.raceMechanic === "gobblinHog";
  if (!flagged && !/(^|-)gobblin-hogs?(-|$)/.test(nameKey(mob?.name))) return;
  const { int, dex } = sys.stats ?? {};
  if (!int || !dex) return;
  [int.mod, dex.mod] = [dex.mod, int.mod];
}
